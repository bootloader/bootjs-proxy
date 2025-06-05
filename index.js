const fs = require('fs');
const path = require('path');
const config = require('@bootloader/config');
const pathy = require('@bootloader/utils/pathy');
const httpProxy = require('http-proxy');
const httpNative = require('http');
//const express = require("express");

const httpProxyStore = config.store('http-proxy');
var agent = new httpNative.Agent({ maxSockets: Number.MAX_VALUE });

const proxyFlags = {
  debug: false,
  initd: false,
};

let proxyConfig = null;
function loadProxyConfig() {
  if (proxyConfig) return proxyConfig;

  let root = pathy.getCallerDir(new Error());

  const filePath = path.resolve(root, 'config/proxy.json');

  if (fs.existsSync(filePath)) {
    const fileData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    proxyConfig = {
      headers: fileData.headers || {},
      mappings: Object.values(fileData.context || {}),
    };
  } else {
    console.warn('Proxy configuration file not found at', filePath);
    proxyConfig = {
      headers: {},
      mappings: [],
    };
    const headerKeys =
      config
        .getIfPresent('proxy.request.headers')
        ?.split(',')
        .map(s => s.trim()) || [];
    headerKeys.forEach(header => {
      const key = config.getIfPresent(`proxy.request.header.${header}.key`);
      const value = config.getIfPresent(`proxy.request.header.${header}.value`);
      if (key && value) proxyConfig.headers[key] = value;
    });

    const mappingKeys =
      config
        .getIfPresent('proxy.mappings')
        ?.split(',')
        .map(s => s.trim()) || [];
    proxyConfig.mappings = mappingKeys
      .map(mapping => ({
        context: config.getIfPresent(`proxy.mapping.${mapping}.context`) || mapping,
        server: config.getIfPresent(`proxy.mapping.${mapping}.server`),
        targetContext: config.getIfPresent(`proxy.mapping.${mapping}.target-context`) || mapping,
      }))
      .filter(m => m.server);
  }

  return proxyConfig;
}

const proxy = httpProxy.createProxyServer({
  hostRewrite: true,
  changeOrigin: true,
  secure: false,
  agent: agent,
});

proxy.on('error', function (err, req, res) {
  proxyFlags.debug && console.log('proxyError', err);
  res.end('Something went wrong. And we are reporting a custom error message.');
});

proxy.on('proxyReq', function (proxyReq, req, res, options) {
  proxyFlags.debug && console.log('proxyReq');

  for (let key in httpProxyStore.headers) {
    proxyReq.setHeader(key, httpProxyStore.headers[key]);
  }
});

proxy.on('proxyRes', function (proxyRes, req, res) {
  proxyFlags.debug && console.log('proxyRes');
});

proxy.on('end', function (req, res, proxyRes) {
  proxyFlags.debug && console.log('proxyEnd');
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
  const configData = loadProxyConfig(); // uses JSON or fallback
  for (const [key, value] of Object.entries(configData.headers || {})) {
    appendRequestHeader(key, value);
  }
  proxyFlags.initd = true;
}

module.exports = {
  router: ({ express }) => {
    const router = express.Router();
    loadProxyConfig().mappings.forEach(({ context, server, targetContext }) => {
      if (!context || !server) return;
      const pathContext = `/${context}/`;
      const pathTarget = `/${targetContext || context}`;
      console.log('########## proxy mapping', { context, server, targetContext: pathTarget });
      router.use(pathContext, module.exports.forward(server, { path: pathTarget }));
    });
    return router;
  },
  setup(app) {
    loadProxyConfig().mappings.map(({ context, server, targetContext }) => {
      if (!context || !server) return;
      const pathContext = `/${context}/`;
      const pathTarget = `/${targetContext || context}`;
      console.log('########## proxy mapping', { context, server, targetContext: pathTarget });
      router.use(pathContext, module.exports.forward(server, { path: pathTarget }));
    });
  },
  forward(host, options) {
    host = host.replace(/\/+$/, '');
    if (options.path) {
      //options.https = false;
      options.proxyReqPathResolver = function (req) {
        var parts = req.url.split('?');
        var queryString = parts[1];
        var updatedPath = options.path + parts[0];
        return updatedPath + (queryString ? '?' + queryString : '');
      };
    }
    let target = (host + '/' + options.path || '').replace(/(\/)\/+/g, '$1').replace(/^http(s?):/, 'http$1:/');

    return function (req, res, next) {
      console.log('########## proxy forward', {
        from: `${req.protocol}://${req.headers.host}${req.originalUrl}`,
        to: `${target}${req.url}`,
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
          changeOrigin: false,
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
  },
};
