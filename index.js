const config = require("lib-config");
const httpProxy = require("http-proxy");
const httpNative   = require('http');

const httpProxyStore = config.store("http-proxy");
var agent = new httpNative.Agent({ maxSockets: Number.MAX_VALUE });

// const httpNative = require("http");
// const agent = new httpNative.Agent({ maxSockets: Number.MAX_VALUE });
const proxy = httpProxy.createProxyServer({
    hostRewrite: true,
    changeOrigin: true,
    secure: false,
    agent: agent
});

const proxyFlags = {
    debug: false,
    initd: false
};

proxy.on("error", function (err, req, res) {
    proxyFlags.debug && console.log("proxyError", err);
    res.end("Something went wrong. And we are reporting a custom error message.");
});

proxy.on("proxyReq", function (proxyReq, req, res, options) {
    proxyFlags.debug && console.log("proxyReq");

    for (let key in httpProxyStore.headers) {
        proxyReq.setHeader(key, httpProxyStore.headers[key]);
    }
});

proxy.on("proxyRes", function (proxyRes, req, res) {
    proxyFlags.debug && console.log("proxyRes");
});

proxy.on("end", function (req, res, proxyRes) {
    proxyFlags.debug && console.log("proxyEnd");
});

function requestHeaders() {
    httpProxyStore.headers = httpProxyStore.headers || {};
    return httpProxyStore.headers;
}

function appendRequestHeader(key, value) {
    let headers = requestHeaders();
    headers[key] = value;
}

function init() {
    if (proxyFlags.initd) return;

    config
        .get("proxy.request.headers")
        ?.split(",")
        .map(mapping => mapping.trim())
        .map(function (mapping) {
            let headerKey = config.getIfPresent(`proxy.request.header.${mapping}.key`);
            let headerValue = config.getIfPresent(`proxy.request.header.${mapping}.value`);
            appendRequestHeader(headerKey, headerValue);
        });

    proxyFlags.initd = true;
}

module.exports = {
    setup(app) {
        config
            .get("proxy.mappings")
            ?.split(",")
            .map(mapping => mapping.trim())
            .map(mapping => {
                let context = config.getIfPresent(`proxy.mapping.${mapping}.context`) || mapping;

                let server = config.getIfPresent(`proxy.mapping.${mapping}.server`);
                let targetContext = config.getIfPresent(`proxy.mapping.${mapping}.target-context`) || context;

                if (server) {
                    console.log("########## proxy mapping", JSON.stringify({ context, server, targetContext }));
                    app.use(`/${context}/`, this.forward(`${server}/`, { path: `/${targetContext}` }));
                }
            });
    },
    forward(host, options) {
        host = host.replace(/\/+$/, "");
        if(options.path){
            //options.https = false;
            options.proxyReqPathResolver = function(req){
                var parts = req.url.split('?');
                var queryString = parts[1];
                var updatedPath = options.path + parts[0];
                return updatedPath + (queryString ? '?' + queryString : '');
            }
        }
        let target = (host + "/" + options.path || "").replace(/(\/)\/+/g, "$1").replace(/^http(s?):/, "http$1:/");

        return function (req, res, next) {
            console.log("########## proxy forward", {
                from: `${req.protocol}://${req.headers.host}${req.originalUrl}`,
                to: `${target}${req.url}`
            });
            proxy.web(
                req,
                res,
                {
                    xfwd: true,
                    secure: false,
                    prependPath: true,
                    target: target,
                    toProxy: false,
                    changeOrigin: false
                },
                function (a, b, c, d, e) {
                    next(a, b, c, d, e);
                }
            );
        };
    },
    appendRequestHeader(key, value) {
        init();
        appendRequestHeader(key, value);
    }
};
