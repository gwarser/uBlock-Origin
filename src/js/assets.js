/*******************************************************************************

    uBlock Origin - a browser extension to block requests.
    Copyright (C) 2014-present Raymond Hill

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.

    Home: https://github.com/gorhill/uBlock
*/

/* global WebAssembly */

'use strict';

/******************************************************************************/

µBlock.assets = (function() {

/******************************************************************************/

var reIsExternalPath = /^(?:[a-z-]+):\/\//,
    reIsUserAsset = /^user-/,
    errorCantConnectTo = vAPI.i18n('errorCantConnectTo'),
    noopfunc = function(){};

var api = {
};

/******************************************************************************/

var observers = [];

api.addObserver = function(observer) {
    if ( observers.indexOf(observer) === -1 ) {
        observers.push(observer);
    }
};

api.removeObserver = function(observer) {
    var pos;
    while ( (pos = observers.indexOf(observer)) !== -1 ) {
        observers.splice(pos, 1);
    }
};

var fireNotification = function(topic, details) {
    var result, r;
    for ( var i = 0; i < observers.length; i++ ) {
        r = observers[i](topic, details);
        if ( r !== undefined ) { result = r; }
    }
    return result;
};

/******************************************************************************/

api.fetchText = function(url, onLoad, onError) {
    var isExternal = reIsExternalPath.test(url),
        actualUrl = isExternal ? url : vAPI.getURL(url);

    // https://github.com/gorhill/uBlock/issues/2592
    // Force browser cache to be bypassed, but only for resources which have
    // been fetched more than one hour ago.
    if ( isExternal ) {
        var queryValue = '_=' + Math.floor(Date.now() / 7200000);
        if ( actualUrl.indexOf('?') === -1 ) {
            actualUrl += '?';
        } else {
            actualUrl += '&';
        }
        actualUrl += queryValue;
    }

    if ( typeof onError !== 'function' ) {
        onError = onLoad;
    }

    var contentLoaded = 0,
        timeoutAfter = µBlock.hiddenSettings.assetFetchTimeout * 1000 || 30000,
        timeoutTimer,
        xhr = new XMLHttpRequest();

    var cleanup = function() {
        xhr.removeEventListener('load', onLoadEvent);
        xhr.removeEventListener('error', onErrorEvent);
        xhr.removeEventListener('abort', onErrorEvent);
        xhr.removeEventListener('progress', onProgressEvent);
        if ( timeoutTimer !== undefined ) {
            clearTimeout(timeoutTimer);
            timeoutTimer = undefined;
        }
    };

    // https://github.com/gorhill/uMatrix/issues/15
    var onLoadEvent = function() {
        cleanup();
        // xhr for local files gives status 0, but actually succeeds
        var details = {
            url: url,
            content: '',
            statusCode: this.status || 200,
            statusText: this.statusText || ''
        };
        if ( details.statusCode < 200 || details.statusCode >= 300 ) {
            return onError.call(null, details);
        }
        // consider an empty result to be an error
        if ( stringIsNotEmpty(this.responseText) === false ) {
            return onError.call(null, details);
        }
        // we never download anything else than plain text: discard if response
        // appears to be a HTML document: could happen when server serves
        // some kind of error page I suppose
        var text = this.responseText.trim();
        if ( text.startsWith('<') && text.endsWith('>') ) {
            return onError.call(null, details);
        }
        details.content = this.responseText;
        onLoad(details);
    };

    var onErrorEvent = function() {
        cleanup();
        µBlock.logger.writeOne('', 'error', errorCantConnectTo.replace('{{msg}}', actualUrl));
        onError({ url: url, content: '' });
    };

    var onTimeout = function() {
        xhr.abort();
    };

    // https://github.com/gorhill/uBlock/issues/2526
    // - Timeout only when there is no progress.
    var onProgressEvent = function(ev) {
        if ( ev.loaded === contentLoaded ) { return; }
        contentLoaded = ev.loaded;
        if ( timeoutTimer !== undefined ) {
            clearTimeout(timeoutTimer); 
        }
        timeoutTimer = vAPI.setTimeout(onTimeout, timeoutAfter);
    };

    // Be ready for thrown exceptions:
    // I am pretty sure it used to work, but now using a URL such as
    // `file:///` on Chromium 40 results in an exception being thrown.
    try {
        xhr.open('get', actualUrl, true);
        xhr.addEventListener('load', onLoadEvent);
        xhr.addEventListener('error', onErrorEvent);
        xhr.addEventListener('abort', onErrorEvent);
        xhr.addEventListener('progress', onProgressEvent);
        xhr.responseType = 'text';
        xhr.send();
        timeoutTimer = vAPI.setTimeout(onTimeout, timeoutAfter);
    } catch (e) {
        onErrorEvent.call(xhr);
    }
};

/******************************************************************************/

// https://github.com/gorhill/uBlock/issues/3331
//   Support the seamless loading of sublists.

api.fetchFilterList = function(mainlistURL, onLoad, onError) {
    var content = [],
        errored = false,
        pendingSublistURLs = new Set([ mainlistURL ]),
        loadedSublistURLs = new Set(),
        toParsedURL = api.fetchFilterList.toParsedURL,
        parsedURL = toParsedURL(mainlistURL);

    var processIncludeDirectives = function(details) {
        var reInclude = /^!#include +(\S+)/gm;
        for (;;) {
            var match = reInclude.exec(details.content);
            if ( match === null ) { break; }
            if ( toParsedURL(match[1]) !== undefined ) { continue; }
            if ( match[1].indexOf('..') !== -1 ) { continue; }
            var subURL =
                parsedURL.origin +
                parsedURL.pathname.replace(/[^/]+$/, match[1]);
            if ( pendingSublistURLs.has(subURL) ) { continue; }
            if ( loadedSublistURLs.has(subURL) ) { continue; }
            pendingSublistURLs.add(subURL);
            api.fetchText(subURL, onLocalLoadSuccess, onLocalLoadError);
        }
    };

    var onLocalLoadSuccess = function(details) {
        if ( errored ) { return; }

        var isSublist = details.url !== mainlistURL;

        pendingSublistURLs.delete(details.url);
        loadedSublistURLs.add(details.url);
        if ( isSublist ) { content.push('\n! ' + '>>>>>>>> ' + details.url); }
        content.push(details.content.trim());
        if ( isSublist ) { content.push('! <<<<<<<< ' + details.url); }
        if ( parsedURL !== undefined && parsedURL.pathname.length > 0 ) {
            processIncludeDirectives(details);
        }

        if ( pendingSublistURLs.size !== 0 ) { return; }

        details.url = mainlistURL;
        details.content = content.join('\n').trim();
        onLoad(details);
    };

    // https://github.com/AdguardTeam/FiltersRegistry/issues/82
    //   Not checking for `errored` status was causing repeated notifications
    //   to the caller. This can happen when more than one out of multiple
    //   sublists can't be fetched.
    var onLocalLoadError = function(details) {
        if ( errored ) { return; }

        errored = true;
        details.url = mainlistURL;
        details.content = '';
        onError(details);
    };

    this.fetchText(mainlistURL, onLocalLoadSuccess, onLocalLoadError);
};

api.fetchFilterList.toParsedURL = function(url) {
    try {
        return new URL(url);
    } catch (ex) {
    }
};

/*******************************************************************************

    The purpose of the asset source registry is to keep key detail information
    about an asset:
    - Where to load it from: this may consist of one or more URLs, either local
      or remote.
    - After how many days an asset should be deemed obsolete -- i.e. in need of
      an update.
    - The origin and type of an asset.
    - The last time an asset was registered.

**/

var assetSourceRegistryStatus,
    assetSourceRegistry = Object.create(null);

var registerAssetSource = function(assetKey, dict) {
    var entry = assetSourceRegistry[assetKey] || {};
    for ( var prop in dict ) {
        if ( dict.hasOwnProperty(prop) === false ) { continue; }
        if ( dict[prop] === undefined ) {
            delete entry[prop];
        } else {
            entry[prop] = dict[prop];
        }
    }
    var contentURL = dict.contentURL;
    if ( contentURL !== undefined ) {
        if ( typeof contentURL === 'string' ) {
            contentURL = entry.contentURL = [ contentURL ];
        } else if ( Array.isArray(contentURL) === false ) {
            contentURL = entry.contentURL = [];
        }
        var remoteURLCount = 0;
        for ( var i = 0; i < contentURL.length; i++ ) {
            if ( reIsExternalPath.test(contentURL[i]) ) {
                remoteURLCount += 1;
            }
        }
        entry.hasLocalURL = remoteURLCount !== contentURL.length;
        entry.hasRemoteURL = remoteURLCount !== 0;
    } else if ( entry.contentURL === undefined ) {
        entry.contentURL = [];
    }
    if ( typeof entry.updateAfter !== 'number' ) {
        entry.updateAfter = 5;
    }
    if ( entry.submitter ) {
        entry.submitTime = Date.now(); // To detect stale entries
    }
    assetSourceRegistry[assetKey] = entry;
};

var unregisterAssetSource = function(assetKey) {
    assetCacheRemove(assetKey);
    delete assetSourceRegistry[assetKey];
};

var saveAssetSourceRegistry = (function() {
    var timer;
    var save = function() {
        timer = undefined;
        vAPI.cacheStorage.set({ assetSourceRegistry: assetSourceRegistry });
    };
    return function(lazily) {
        if ( timer !== undefined ) {
            clearTimeout(timer);
        }
        if ( lazily ) {
            timer = vAPI.setTimeout(save, 500);
        } else {
            save();
        }
    };
})();

var updateAssetSourceRegistry = function(json, silent) {
    var newDict;
    try {
        newDict = JSON.parse(json);
    } catch (ex) {
    }
    if ( newDict instanceof Object === false ) { return; }

    var oldDict = assetSourceRegistry,
        assetKey;

    // Remove obsolete entries (only those which were built-in).
    for ( assetKey in oldDict ) {
        if (
            newDict[assetKey] === undefined &&
            oldDict[assetKey].submitter === undefined
        ) {
            unregisterAssetSource(assetKey);
        }
    }
    // Add/update existing entries. Notify of new asset sources.
    for ( assetKey in newDict ) {
        if ( oldDict[assetKey] === undefined && !silent ) {
            fireNotification(
                'builtin-asset-source-added',
                { assetKey: assetKey, entry: newDict[assetKey] }
            );
        }
        registerAssetSource(assetKey, newDict[assetKey]);
    }
    saveAssetSourceRegistry();
};

var getAssetSourceRegistry = function(callback) {
    // Already loaded.
    if ( assetSourceRegistryStatus === 'ready' ) {
        callback(assetSourceRegistry);
        return;
    }

    // Being loaded.
    if ( Array.isArray(assetSourceRegistryStatus) ) {
        assetSourceRegistryStatus.push(callback);
        return;
    }

    // Not loaded: load it.
    assetSourceRegistryStatus = [ callback ];

    var registryReady = function() {
        var callers = assetSourceRegistryStatus;
        assetSourceRegistryStatus = 'ready';
        var fn;
        while ( (fn = callers.shift()) ) {
            fn(assetSourceRegistry);
        }
    };

    // First-install case.
    var createRegistry = function() {
        api.fetchText(
            µBlock.assetsBootstrapLocation || 'assets/assets.json',
            function(details) {
                updateAssetSourceRegistry(details.content, true);
                registryReady();
            }
        );
    };

    vAPI.cacheStorage.get('assetSourceRegistry', function(bin) {
        if ( !bin || !bin.assetSourceRegistry ) {
            createRegistry();
            return;
        }
        assetSourceRegistry = bin.assetSourceRegistry;
        registryReady();
    });
};

api.registerAssetSource = function(assetKey, details) {
    getAssetSourceRegistry(function() {
        registerAssetSource(assetKey, details);
        saveAssetSourceRegistry(true);
    });
};

api.unregisterAssetSource = function(assetKey) {
    getAssetSourceRegistry(function() {
        unregisterAssetSource(assetKey);
        saveAssetSourceRegistry(true);
    });
};

/*******************************************************************************

    Experimental support for cache storage compression.

    For background information on the topic, see:
    https://github.com/uBlockOrigin/uBlock-issues/issues/141#issuecomment-407737186

**/

let lz4Codec = (function() {
    let lz4wasmInstance;
    let pendingInitialization;
    let textEncoder, textDecoder;
    let ttlCount = 0;
    let ttlTimer;

    const ttlDelay = 60 * 1000;

    let init = function() {
        if (
            lz4wasmInstance === null ||
            WebAssembly instanceof Object === false ||
            typeof WebAssembly.instantiateStreaming !== 'function'
        ) {
            lz4wasmInstance = null;
            return Promise.resolve(null);
        }
        if ( lz4wasmInstance instanceof WebAssembly.Instance ) {
            return Promise.resolve(lz4wasmInstance);
        }
        if ( pendingInitialization === undefined ) {
            pendingInitialization = WebAssembly.instantiateStreaming(
                fetch('lib/lz4-block-codec.wasm', { mode: 'same-origin' })
            ).then(result => {
                pendingInitialization = undefined;
                lz4wasmInstance = result && result.instance || null;
            });
            pendingInitialization.catch(( ) => {
                lz4wasmInstance = null;
            });
        }
        return pendingInitialization;
    };

    // We can't shrink memory usage of wasm instances, and in the current
    // case memory usage can grow to a significant amount given that
    // a single contiguous memory buffer is required to accommodate both
    // input and output data. Thus a time-to-live implementation which
    // will cause the wasm instance to be forgotten after enough time
    // elapse without the instance being used.

    let destroy = function() {
        console.info(
            'uBO: freeing lz4-block-codec.wasm instance (memory.buffer = %d kB)',
            lz4wasmInstance.exports.memory.buffer.byteLength >>> 10
        );
        lz4wasmInstance = undefined;
        textEncoder = textDecoder = undefined;
        ttlCount = 0;
        ttlTimer = undefined;
    };

    let ttlManage = function(count) {
        if ( ttlTimer !== undefined ) {
            clearTimeout(ttlTimer);
            ttlTimer = undefined;
        }
        ttlCount += count;
        if ( ttlCount > 0 ) { return; }
        if ( lz4wasmInstance === null ) { return; }
        ttlTimer = vAPI.setTimeout(destroy, ttlDelay);
    };

    let growMemoryTo = function(byteLength) {
        let lz4api = lz4wasmInstance.exports;
        let neededByteLength = lz4api.getLinearMemoryOffset() + byteLength;
        let pageCountBefore = lz4api.memory.buffer.byteLength >>> 16;
        let pageCountAfter = (neededByteLength + 65535) >>> 16;
        if ( pageCountAfter > pageCountBefore ) {
            lz4api.memory.grow(pageCountAfter - pageCountBefore);
        }
        return lz4api.memory;
    };

    let resolveEncodedValue = function(resolve, key, value) {
        let t0 = window.performance.now();
        let lz4api = lz4wasmInstance.exports;
        let mem0 = lz4api.getLinearMemoryOffset();
        let memory = growMemoryTo(mem0 + 65536 * 4);
        let hashTable = new Int32Array(memory.buffer, mem0, 65536);
        hashTable.fill(-65536, 0, 65536);
        let hashTableSize = hashTable.byteLength;
        if ( textEncoder === undefined ) {
            textEncoder = new TextEncoder();
        }
        let inputArray = textEncoder.encode(value);
        let inputSize = inputArray.byteLength;
        let memSize =
            hashTableSize +
            inputSize +
            8 + lz4api.lz4BlockEncodeBound(inputSize);
        memory = growMemoryTo(memSize);
        let inputMem = new Uint8Array(
            memory.buffer,
            mem0 + hashTableSize,
            inputSize
        );
        inputMem.set(inputArray);
        let outputSize = lz4api.lz4BlockEncode(
            mem0 + hashTableSize,
            inputSize,
            mem0 + hashTableSize + inputSize + 8
        );
        if ( outputSize === 0 ) { resolve(value); }
        let outputMem = new Uint8Array(
            memory.buffer,
            mem0 + hashTableSize + inputSize,
            8 + outputSize
        );
        outputMem[0] = 0x18;
        outputMem[1] = 0x4D;
        outputMem[2] = 0x22;
        outputMem[3] = 0x04;
        outputMem[4] = (inputSize >>>  0) & 0xFF;
        outputMem[5] = (inputSize >>>  8) & 0xFF;
        outputMem[6] = (inputSize >>> 16) & 0xFF;
        outputMem[7] = (inputSize >>> 24) & 0xFF;
        console.info(
            'uBO: [%s] compressed %d bytes into %d bytes in %s ms',
            key,
            inputSize,
            outputSize,
            (window.performance.now() - t0).toFixed(2)
        );
        resolve(new Blob([ outputMem ]));
    };

    let resolveDecodedValue = function(resolve, ev, key, value) {
        let inputBuffer = ev.target.result;
        if ( inputBuffer instanceof ArrayBuffer === false ) {
            return resolve(value);
        }
        let t0 = window.performance.now();
        let metadata = new Uint8Array(inputBuffer, 0, 8);
        if (
            metadata[0] !== 0x18 ||
            metadata[1] !== 0x4D ||
            metadata[2] !== 0x22 ||
            metadata[3] !== 0x04
        ) {
            return resolve(value);
        }
        let inputSize = inputBuffer.byteLength - 8;
        let outputSize = 
            (metadata[4] <<  0) |
            (metadata[5] <<  8) |
            (metadata[6] << 16) |
            (metadata[7] << 24);
        let lz4api = lz4wasmInstance.exports;
        let mem0 = lz4api.getLinearMemoryOffset();
        let memSize = inputSize + outputSize;
        let memory = growMemoryTo(memSize);
        let inputArea = new Uint8Array(
            memory.buffer,
            mem0,
            inputSize
        );
        inputArea.set(new Uint8Array(inputBuffer, 8, inputSize));
        outputSize = lz4api.lz4BlockDecode(inputSize);
        if ( outputSize === 0 ) {
            return resolve(value);
        }
        let outputArea = new Uint8Array(
            memory.buffer,
            mem0 + inputSize,
            outputSize
        );
        if ( textDecoder === undefined ) {
            textDecoder = new TextDecoder();
        }
        value = textDecoder.decode(outputArea);
        console.info(
            'uBO: [%s] decompressed %d bytes into %d bytes in %s ms',
            key,
            inputSize,
            outputSize,
            (window.performance.now() - t0).toFixed(2)
        );
        resolve(value);
    };

    let encodeValue = function(key, value) {
        if ( !lz4wasmInstance ) {
            return Promise.resolve(value);
        }
        return new Promise(resolve => {
            resolveEncodedValue(resolve, key, value);
        });
    };

    let decodeValue = function(key, value) {
        if ( !lz4wasmInstance ) {
            return Promise.resolve(value);
        }
        return new Promise(resolve => {
            let blobReader = new FileReader();
            blobReader.onloadend = ev => {
                resolveDecodedValue(resolve, ev, key, value);
            };
            blobReader.readAsArrayBuffer(value);
        });
    };

    return {
        encode: function(key, value) {
            if ( typeof value !== 'string' || value.length < 4096 ) {
                return Promise.resolve(value);
            }
            ttlManage(1);
            return init().then(( ) => {
                return encodeValue(key, value);
            }).then(result => {
                ttlManage(-1);
                return result;
            });
        },
        decode: function(key, value) {
            if ( value instanceof Blob === false ) {
                return Promise.resolve(value);
            }
            ttlManage(1);
            return init().then(( ) => {
                return decodeValue(key, value);
            }).then(result => {
                ttlManage(-1);
                return result;
            });
        }
    };
})();

/*******************************************************************************

    The purpose of the asset cache registry is to keep track of all assets
    which have been persisted into the local cache.

**/

var assetCacheRegistryStatus,
    assetCacheRegistryStartTime = Date.now(),
    assetCacheRegistry = {};

var getAssetCacheRegistry = function(callback) {
    // Already loaded.
    if ( assetCacheRegistryStatus === 'ready' ) {
        callback(assetCacheRegistry);
        return;
    }

    // Being loaded.
    if ( Array.isArray(assetCacheRegistryStatus) ) {
        assetCacheRegistryStatus.push(callback);
        return;
    }

    // Not loaded: load it.
    assetCacheRegistryStatus = [ callback ];

    var registryReady = function() {
        var callers = assetCacheRegistryStatus;
        assetCacheRegistryStatus = 'ready';
        var fn;
        while ( (fn = callers.shift()) ) {
            fn(assetCacheRegistry);
        }
    };

    vAPI.cacheStorage.get('assetCacheRegistry', function(bin) {
        if ( bin && bin.assetCacheRegistry ) {
            assetCacheRegistry = bin.assetCacheRegistry;
        }
        registryReady();
    });
};

var saveAssetCacheRegistry = (function() {
    var timer;
    var save = function() {
        timer = undefined;
        vAPI.cacheStorage.set({ assetCacheRegistry: assetCacheRegistry });
    };
    return function(lazily) {
        if ( timer !== undefined ) { clearTimeout(timer); }
        if ( lazily ) {
            timer = vAPI.setTimeout(save, 500);
        } else {
            save();
        }
    };
})();

var assetCacheRead = function(assetKey, callback) {
    let internalKey = 'cache/' + assetKey;

    let reportBack = function(content) {
        if ( content instanceof Blob ) { content = ''; }
        let details = { assetKey: assetKey, content: content };
        if ( content === '' ) { details.error = 'E_NOTFOUND'; }
        callback(details);
    };

    let onAssetRead = function(bin) {
        if (
            bin instanceof Object === false ||
            bin.hasOwnProperty(internalKey) === false
        ) {
            return reportBack('');
        }
        let entry = assetCacheRegistry[assetKey];
        if ( entry === undefined ) {
            return reportBack('');
        }
        entry.readTime = Date.now();
        saveAssetCacheRegistry(true);
        if ( µBlock.hiddenSettings.cacheStorageCompression !== true ) {
            return reportBack(bin[internalKey]);
        }
        lz4Codec.decode(internalKey, bin[internalKey]).then(result => {
            reportBack(result);
        });
    };

    let onReady = function() {
        vAPI.cacheStorage.get(internalKey, onAssetRead);
    };

    getAssetCacheRegistry(onReady);
};

var assetCacheWrite = function(assetKey, details, callback) {
    let internalKey = 'cache/' + assetKey;
    let content = '';
    if ( typeof details === 'string' ) {
        content = details;
    } else if ( details instanceof Object ) {
        content = details.content || '';
    }

    if ( content === '' ) {
        return assetCacheRemove(assetKey, callback);
    }

    let reportBack = function(content) {
        let bin = { assetCacheRegistry: assetCacheRegistry };
        bin[internalKey] = content;
        vAPI.cacheStorage.set(bin);
        let details = { assetKey: assetKey, content: content };
        if ( typeof callback === 'function' ) {
            callback(details);
        }
        fireNotification('after-asset-updated', details);
    };

    let onReady = function() {
        let entry = assetCacheRegistry[assetKey];
        if ( entry === undefined ) {
            entry = assetCacheRegistry[assetKey] = {};
        }
        entry.writeTime = entry.readTime = Date.now();
        if ( details instanceof Object && typeof details.url === 'string' ) {
            entry.remoteURL = details.url;
        }
        if ( µBlock.hiddenSettings.cacheStorageCompression !== true ) {
            return reportBack(content);
        }
        lz4Codec.encode(internalKey, content).then(result => {
            reportBack(result);
        });
    };
    getAssetCacheRegistry(onReady);
};

var assetCacheRemove = function(pattern, callback) {
    var onReady = function() {
        var cacheDict = assetCacheRegistry,
            removedEntries = [],
            removedContent = [];
        for ( var assetKey in cacheDict ) {
            if ( pattern instanceof RegExp && !pattern.test(assetKey) ) {
                continue;
            }
            if ( typeof pattern === 'string' && assetKey !== pattern ) {
                continue;
            }
            removedEntries.push(assetKey);
            removedContent.push('cache/' + assetKey);
            delete cacheDict[assetKey];
        }
        if ( removedContent.length !== 0 ) {
            vAPI.cacheStorage.remove(removedContent);
            var bin = { assetCacheRegistry: assetCacheRegistry };
            vAPI.cacheStorage.set(bin);
        }
        if ( typeof callback === 'function' ) {
            callback();
        }
        for ( var i = 0; i < removedEntries.length; i++ ) {
            fireNotification('after-asset-updated', { assetKey: removedEntries[i] });
        }
    };

    getAssetCacheRegistry(onReady);
};

var assetCacheMarkAsDirty = function(pattern, exclude, callback) {
    var onReady = function() {
        var cacheDict = assetCacheRegistry,
            cacheEntry,
            mustSave = false;
        for ( var assetKey in cacheDict ) {
            if ( pattern instanceof RegExp ) {
                if ( pattern.test(assetKey) === false ) { continue; }
            } else if ( typeof pattern === 'string' ) {
                if ( assetKey !== pattern ) { continue; }
            } else if ( Array.isArray(pattern) ) {
                if ( pattern.indexOf(assetKey) === -1 ) { continue; }
            }
            if ( exclude instanceof RegExp ) {
                if ( exclude.test(assetKey) ) { continue; }
            } else if ( typeof exclude === 'string' ) {
                if ( assetKey === exclude ) { continue; }
            } else if ( Array.isArray(exclude) ) {
                if ( exclude.indexOf(assetKey) !== -1 ) { continue; }
            }
            cacheEntry = cacheDict[assetKey];
            if ( !cacheEntry.writeTime ) { continue; }
            cacheDict[assetKey].writeTime = 0;
            mustSave = true;
        }
        if ( mustSave ) {
            var bin = { assetCacheRegistry: assetCacheRegistry };
            vAPI.cacheStorage.set(bin);
        }
        if ( typeof callback === 'function' ) {
            callback();
        }
    };
    if ( typeof exclude === 'function' ) {
        callback = exclude;
        exclude = undefined;
    }
    getAssetCacheRegistry(onReady);
};

/******************************************************************************/

var stringIsNotEmpty = function(s) {
    return typeof s === 'string' && s !== '';
};

/*******************************************************************************

    User assets are NOT persisted in the cache storage. User assets are
    recognized by the asset key which always starts with 'user-'.

    TODO(seamless migration):
    Can remove instances of old user asset keys when I am confident all users
    are using uBO v1.11 and beyond.

**/

var readUserAsset = function(assetKey, callback) {
    var reportBack = function(content) {
        callback({ assetKey: assetKey, content: content });
    };

    var onLoaded = function(bin) {
        if ( !bin ) { return reportBack(''); }
        var content = '';
        if ( typeof bin['cached_asset_content://assets/user/filters.txt'] === 'string' ) {
            content = bin['cached_asset_content://assets/user/filters.txt'];
            vAPI.cacheStorage.remove('cached_asset_content://assets/user/filters.txt');
        }
        if ( typeof bin['assets/user/filters.txt'] === 'string' ) {
            content = bin['assets/user/filters.txt'];
            // TODO(seamless migration):
            // Uncomment once all moved to v1.11+.
            //vAPI.storage.remove('assets/user/filters.txt');
        }
        if ( typeof bin[assetKey] === 'string' ) {
            // TODO(seamless migration):
            // Replace conditional with assignment once all moved to v1.11+
            if ( content !== bin[assetKey] ) {
                saveUserAsset(assetKey, content);
            }
        } else if ( content !== '' ) {
            saveUserAsset(assetKey, content);
        }
        return reportBack(content);
    };
    var toRead = assetKey;
    if ( assetKey === µBlock.userFiltersPath ) {
        toRead = [
            assetKey,
            'assets/user/filters.txt',
            'cached_asset_content://assets/user/filters.txt'
        ];
    }
    vAPI.storage.get(toRead, onLoaded);
};

var saveUserAsset = function(assetKey, content, callback) {
    var bin = {};
    bin[assetKey] = content;
    // TODO(seamless migration):
    // This is for forward compatibility. Only for a limited time. Remove when
    // everybody moved to 1.11.0 and beyond.
    // >>>>>>>>
    if ( assetKey === µBlock.userFiltersPath ) {
        bin['assets/user/filters.txt'] = content;
    }
    // <<<<<<<<
    var onSaved = function() {
        if ( callback instanceof Function ) {
            callback({ assetKey: assetKey, content: content });
        }
    };
    vAPI.storage.set(bin, onSaved);
};

/******************************************************************************/

api.get = function(assetKey, options, callback) {
    if ( typeof options === 'function' ) {
        callback = options;
        options = {};
    } else if ( typeof callback !== 'function' ) {
        callback = noopfunc;
    }

    if ( assetKey === µBlock.userFiltersPath ) {
        readUserAsset(assetKey, callback);
        return;
    }

    var assetDetails = {},
        contentURLs,
        contentURL;

    var reportBack = function(content, err) {
        var details = { assetKey: assetKey, content: content };
        if ( err ) {
            details.error = assetDetails.lastError = err;
        } else {
            assetDetails.lastError = undefined;
        }
        callback(details);
    };

    var onContentNotLoaded = function() {
        var isExternal;
        while ( (contentURL = contentURLs.shift()) ) {
            isExternal = reIsExternalPath.test(contentURL);
            if ( isExternal === false || assetDetails.hasLocalURL !== true ) {
                break;
            }
        }
        if ( !contentURL ) {
            return reportBack('', 'E_NOTFOUND');
        }
        if ( assetDetails.content === 'filters' ) {
            api.fetchFilterList(contentURL, onContentLoaded, onContentNotLoaded);
        } else {
            api.fetchText(contentURL, onContentLoaded, onContentNotLoaded);
        }
    };

    var onContentLoaded = function(details) {
        if ( stringIsNotEmpty(details.content) === false ) {
            onContentNotLoaded();
            return;
        }
        if ( reIsExternalPath.test(contentURL) && options.dontCache !== true ) {
            assetCacheWrite(assetKey, {
                content: details.content,
                url: contentURL
            });
        }
        reportBack(details.content);
    };

    var onCachedContentLoaded = function(details) {
        if ( details.content !== '' ) {
            return reportBack(details.content);
        }
        getAssetSourceRegistry(function(registry) {
            assetDetails = registry[assetKey] || {};
            if ( typeof assetDetails.contentURL === 'string' ) {
                contentURLs = [ assetDetails.contentURL ];
            } else if ( Array.isArray(assetDetails.contentURL) ) {
                contentURLs = assetDetails.contentURL.slice(0);
            } else {
                contentURLs = [];
            }
            onContentNotLoaded();
        });
    };

    assetCacheRead(assetKey, onCachedContentLoaded);
};

/******************************************************************************/

var getRemote = function(assetKey, callback) {
   var assetDetails = {},
        contentURLs,
        contentURL;

    var reportBack = function(content, err) {
        var details = { assetKey: assetKey, content: content };
        if ( err ) {
            details.error = assetDetails.lastError = err;
        } else {
            assetDetails.lastError = undefined;
        }
        callback(details);
    };

    var onRemoteContentLoaded = function(details) {
        if ( stringIsNotEmpty(details.content) === false ) {
            registerAssetSource(assetKey, { error: { time: Date.now(), error: 'No content' } });
            tryLoading();
            return;
        }
        assetCacheWrite(assetKey, {
            content: details.content,
            url: contentURL
        });
        registerAssetSource(assetKey, { error: undefined });
        reportBack(details.content);
    };

    var onRemoteContentError = function(details) {
        var text = details.statusText;
        if ( details.statusCode === 0 ) {
            text = 'network error';
        }
        registerAssetSource(assetKey, { error: { time: Date.now(), error: text } });
        tryLoading();
    };

    var tryLoading = function() {
        while ( (contentURL = contentURLs.shift()) ) {
            if ( reIsExternalPath.test(contentURL) ) { break; }
        }
        if ( !contentURL ) {
            return reportBack('', 'E_NOTFOUND');
        }
        if ( assetDetails.content === 'filters' ) {
            api.fetchFilterList(contentURL, onRemoteContentLoaded, onRemoteContentError);
        } else {
            api.fetchText(contentURL, onRemoteContentLoaded, onRemoteContentError);
        }
    };

    getAssetSourceRegistry(function(registry) {
        assetDetails = registry[assetKey] || {};
        if ( typeof assetDetails.contentURL === 'string' ) {
            contentURLs = [ assetDetails.contentURL ];
        } else if ( Array.isArray(assetDetails.contentURL) ) {
            contentURLs = assetDetails.contentURL.slice(0);
        } else {
            contentURLs = [];
        }
        tryLoading();
    });
};

/******************************************************************************/

api.put = function(assetKey, content, callback) {
    if ( reIsUserAsset.test(assetKey) ) {
        return saveUserAsset(assetKey, content, callback);
    }
    assetCacheWrite(assetKey, content, callback);
};

/******************************************************************************/

api.metadata = function(callback) {
    var assetRegistryReady = false,
        cacheRegistryReady = false;

    var onReady = function() {
        var assetDict = JSON.parse(JSON.stringify(assetSourceRegistry)),
            cacheDict = assetCacheRegistry,
            assetEntry, cacheEntry,
            now = Date.now(), obsoleteAfter;
        for ( var assetKey in assetDict ) {
            assetEntry = assetDict[assetKey];
            cacheEntry = cacheDict[assetKey];
            if ( cacheEntry ) {
                assetEntry.cached = true;
                assetEntry.writeTime = cacheEntry.writeTime;
                obsoleteAfter = cacheEntry.writeTime + assetEntry.updateAfter * 86400000;
                assetEntry.obsolete = obsoleteAfter < now;
                assetEntry.remoteURL = cacheEntry.remoteURL;
            } else if (
                assetEntry.contentURL &&
                assetEntry.contentURL.length !== 0
            ) {
                assetEntry.writeTime = 0;
                obsoleteAfter = 0;
                assetEntry.obsolete = true;
            }
        }
        callback(assetDict);
    };

    getAssetSourceRegistry(function() {
        assetRegistryReady = true;
        if ( cacheRegistryReady ) { onReady(); }
    });

    getAssetCacheRegistry(function() {
        cacheRegistryReady = true;
        if ( assetRegistryReady ) { onReady(); }
    });
};

/******************************************************************************/

api.purge = assetCacheMarkAsDirty;

api.remove = function(pattern, callback) {
    assetCacheRemove(pattern, callback);
};

api.rmrf = function() {
    assetCacheRemove(/./);
};

/******************************************************************************/

// Asset updater area.
var updaterStatus,
    updaterTimer,
    updaterAssetDelayDefault = 120000,
    updaterAssetDelay = updaterAssetDelayDefault,
    updaterUpdated = [],
    updaterFetched = new Set(),
    noRemoteResources;

var updateFirst = function() {
    // https://github.com/gorhill/uBlock/commit/126110c9a0a0630cd556f5cb215422296a961029
    //   Firefox extension reviewers do not want uBO/webext to fetch its own
    //   scriptlets/resources asset from the project's own repo (github.com).
    // https://github.com/uBlockOrigin/uAssets/issues/1647#issuecomment-371456830
    //   Allow self-hosted dev build to update: if update_url is present but
    //   null, assume the extension is hosted on AMO.
    if ( noRemoteResources === undefined ) {
        noRemoteResources =
            vAPI.webextFlavor.soup.has('firefox') &&
            vAPI.webextFlavor.soup.has('webext') &&
            vAPI.webextFlavor.soup.has('devbuild') === false;
    }
    updaterStatus = 'updating';
    updaterFetched.clear();
    updaterUpdated = [];
    fireNotification('before-assets-updated');
    updateNext();
};

var updateNext = function() {
    var assetDict, cacheDict;

    // This will remove a cached asset when it's no longer in use.
    var garbageCollectOne = function(assetKey) {
        var cacheEntry = cacheDict[assetKey];
        if ( cacheEntry && cacheEntry.readTime < assetCacheRegistryStartTime ) {
            assetCacheRemove(assetKey);
        }
    };

    var findOne = function() {
        var now = Date.now(),
            assetEntry, cacheEntry;
        for ( var assetKey in assetDict ) {
            assetEntry = assetDict[assetKey];
            if ( assetEntry.hasRemoteURL !== true ) { continue; }
            if ( updaterFetched.has(assetKey) ) { continue; }
            cacheEntry = cacheDict[assetKey];
            if ( cacheEntry && (cacheEntry.writeTime + assetEntry.updateAfter * 86400000) > now ) {
                continue;
            }
            // Update of user scripts/resources forbidden?
            if ( assetKey === 'ublock-resources' && noRemoteResources ) {
                continue;
            }
            if (
                fireNotification(
                    'before-asset-updated',
                    { assetKey: assetKey,  type: assetEntry.content }
                ) === true
            ) {
                return assetKey;
            }
            garbageCollectOne(assetKey);
        }
    };

    var updatedOne = function(details) {
        if ( details.content !== '' ) {
            updaterUpdated.push(details.assetKey);
            if ( details.assetKey === 'assets.json' ) {
                updateAssetSourceRegistry(details.content);
            }
        } else {
            fireNotification('asset-update-failed', { assetKey: details.assetKey });
        }
        if ( findOne() !== undefined ) {
            vAPI.setTimeout(updateNext, updaterAssetDelay);
        } else {
            updateDone();
        }
    };

    var updateOne = function() {
        var assetKey = findOne();
        if ( assetKey === undefined ) {
            return updateDone();
        }
        updaterFetched.add(assetKey);
        getRemote(assetKey, updatedOne);
    };

    getAssetSourceRegistry(function(dict) {
        assetDict = dict;
        if ( !cacheDict ) { return; }
        updateOne();
    });

    getAssetCacheRegistry(function(dict) {
        cacheDict = dict;
        if ( !assetDict ) { return; }
        updateOne();
    });
};

var updateDone = function() {
    var assetKeys = updaterUpdated.slice(0);
    updaterFetched.clear();
    updaterUpdated = [];
    updaterStatus = undefined;
    updaterAssetDelay = updaterAssetDelayDefault;
    fireNotification('after-assets-updated', { assetKeys: assetKeys });
};

api.updateStart = function(details) {
    var oldUpdateDelay = updaterAssetDelay,
        newUpdateDelay = typeof details.delay === 'number' ?
            details.delay :
            updaterAssetDelayDefault;
    updaterAssetDelay = Math.min(oldUpdateDelay, newUpdateDelay);
    if ( updaterStatus !== undefined ) {
        if ( newUpdateDelay < oldUpdateDelay ) {
            clearTimeout(updaterTimer);
            updaterTimer = vAPI.setTimeout(updateNext, updaterAssetDelay);
        }
        return;
    }
    updateFirst();
};

api.updateStop = function() {
    if ( updaterTimer ) {
        clearTimeout(updaterTimer);
        updaterTimer = undefined;
    }
    if ( updaterStatus !== undefined ) {
        updateDone();
    }
};

/******************************************************************************/

return api;

/******************************************************************************/

})();

/******************************************************************************/
