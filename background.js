const USER_AGENT = 'Explode/0.5';
const API_ROOT = 'http://api.longurl.org/v2/';
const FETCH_DELAY = 800;
const SERVICES_CACHE_TIME = 86400 * 1000;
const EXTRA_SERVICES = ['j.mp', 'flic.kr', 'w33.us', 'guao.cc', 'jan.io',
                        'disq.us'];

var services = {};
var outstandingReqs = [];
var curReq = null;

/* Functions for dealing with the LongURL API */

function xhrGet(url, callback) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.onreadystatechange = function(resp) {
        if (xhr.readyState == 4)
            callback(xhr);
    };
    xhr.send();
}

function apiUrl(method, params) {
    var url = API_ROOT + method + '?format=json&user-agent=' +
        encodeURIComponent(USER_AGENT);
    for (k in params)
        url += '&' + k + '=' + encodeURIComponent(params[k]);
    return url;
}

/* Setup the service list; fetch and cache again if needed */

function loadCachedServices() {
    services = JSON.parse(localStorage['services']);
    EXTRA_SERVICES.forEach(function(s) {
        services[s] = {host: s, regex: null};
    });
}

if (localStorage['services'] && Date.now() < localStorage['servicesExpire']) {
    loadCachedServices();
} else {
    xhrGet(apiUrl('services'), function(xhr) {
        var date = Date.parse(xhr.getResponseHeader('Date'));
        localStorage['servicesExpire'] = date + SERVICES_CACHE_TIME;
        localStorage['services'] = xhr.responseText;
        loadCachedServices();
    });
}

/* Handle a bunch of requests from the content script. We stuff the
 * callback into req so we can pull it out later. All the requests
 * should finish coming in almost immediately, at which point the first
 * req's XHR will be running and the rest will be queued up. */

function isShortenedUrl(url) {
    var a = document.createElement('a');
    a.href = url;
    var svc = services[a.hostname];
    return svc ? (svc.regex ? svc.regex.match(url) : true) : false;
}

chrome.extension.onConnect.addListener(function (port) {
    switch (port.name) {
    case 'explodeUrlRequest':
        port.onMessage.addListener(function (req) {
            handleReq(req, port);
        });
    }
});

function handleReq(req, port) {
    req.port = port;
    if (localStorage[req.url]) {
        console.log('cached: ' + req.url);
        updateLink(req);
    } else {
        if (isShortenedUrl(req.url)) {
            console.log('new: ' + req.url);
            port.postMessage({url: req.url, loading: true});
            outstandingReqs.push(req);
            fetchReqs();
        }
    }
}

/* The main loop, so to speak. */

function fetchReqs() {
    if (curReq || outstandingReqs.length == 0)
        return;
    curReq = outstandingReqs.shift();
    if (localStorage[curReq.url]) {
        updateLink(curReq);
        fetchNextReq();
    } else {
        xhrGet(apiUrl('expand', {title: 1, url: curReq.url}), function(xhr) {
            var res = loadResponse(xhr.responseText);
            if (res) {
                localStorage[curReq.url] = JSON.stringify(res);
                updateLink(curReq);
            } else {
                curReq.port.postMessage({url: curReq.url, failed: true});
            }
            fetchNextReq();
        });
    }
}

function fetchNextReq() {
    curReq = null;
    setTimeout(fetchReqs, FETCH_DELAY);
}

function normalize(s) {
    /* XXX: interpret entities. */
    return s ? s.replace(/\s+/g, ' ') : null;
}

function loadResponse(t) {
    try {
        var res = JSON.parse(t);
        if (res['long-url']) {
            return { longUrl: res['long-url'], title: normalize(res.title) };
        } else {
            console.log('error: ' + t);
        }
    } catch (e) {
        console.log('no reply: ' + curReq.url);
    }
    return null;
}

/* And here's where we actually invoke the callback once the URL and
 * title come back from LongURL. */

function updateLink(req) {
    var info = JSON.parse(localStorage[req.url]);
    info.url = req.url;
    info.munge = localStorage['mungeLinks'];
    req.port.postMessage(info);
}
