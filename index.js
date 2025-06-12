const fs = require('fs');
const path = require('path');
const config = require('@bootloader/config');
const pathy = require('@bootloader/utils/pathy');
const httpProxy = require('http-proxy');
const httpNative = require('http');

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');


//const express = require("express");
const log4js = require("@bootloader/log4js");
var logger = log4js.getLogger("proxy");

const httpProxyStore = config.store('http-proxy');
var agent = new httpNative.Agent({ maxSockets: Number.MAX_VALUE });

const proxyFlags = {
  debug: false,
  initd: false,
  on: {
    request() {},
    response() {},
    error() {},
    end() {},
    ready() {
      console.log('ProxyService is ready');
    },
  },
};

let proxyConfig = null;
function loadProxyConfig() {
  if (proxyConfig) return proxyConfig;

  let root = pathy.getCallerDir(new Error());

  const filePath = path.resolve(root, 'config/proxy.json');

  if (fs.existsSync(filePath)) {
    logger.info("Loading proxy config:"+filePath)
    const fileData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    proxyConfig = {
      headers: fileData.headers || {},
      mappings: Object.values(fileData.forward || {}),
    };
  } else {
    logger.info("Loading proxy config:"+filePath)
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
        target: config.getIfPresent(`proxy.mapping.${mapping}.target-context`) || mapping,
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
  logger.debug('proxyError', err);
  res.end('Something went wrong. And we are reporting a custom error message.');
  proxyFlags.on.error({ err, request: req, response: res });
});

proxy.on('proxyReq', function (proxyReq, req, res, options) {
  logger.debug('proxyReq');

  for (let key in httpProxyStore.headers) {
    proxyReq.setHeader(key, httpProxyStore.headers[key]);
  }
  proxyFlags.on.request({ requestProxy: proxyReq, request: req, response: res, options });
});

proxy.on('proxyRes', function (proxyRes, req, res) {
  logger.debug('proxyRes');
  proxyFlags.on.response({ responseProxy: proxyRes, request: req, response: res });
});

proxy.on('end', function (req, res, proxyRes) {
  logger.debug('proxyEnd');
  proxyFlags.on.response({ responseProxy: proxyRes, request: req, response: res });
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

  beforeProxy(apiRouter){
    // Middleware setup
      apiRouter.use(cors());
      apiRouter.use(function (req, res, next) {
          res.setHeader("Access-Control-Allow-Origin", "*");
          res.setHeader('Access-Control-Allow-Methods', '*');
          res.setHeader("Access-Control-Allow-Headers", "*");
          next();
      });
      apiRouter.options('*', cors())
      var customParser = bodyParser.json({type: function(req) {
          console.log("customParser:bodyParser.json",req.headers['content-type'])
          if (req.headers['content-type'] === ""){
              return req.headers['content-type'] = 'application/json';
          }
          else if (typeof req.headers['content-type'] === 'undefined'){
              return req.headers['content-type'] = 'application/json';
          } else {
              return req.headers['content-type'] = 'application/json';
          }
      }});
      apiRouter.use(cookieParser());
      return {bodyParser,customParser}
  },

  router: ({ express, request, response, end, error }) => {
    proxyFlags.on.request = request || proxyFlags.on.request;
    proxyFlags.on.response = response || proxyFlags.on.response;
    proxyFlags.on.end = end || proxyFlags.on.end;
    proxyFlags.on.error = error || proxyFlags.on.error;

    const router = express.Router();

    let { bodyParser,customParser } = module.exports.beforeProxy(router);

    loadProxyConfig().mappings.forEach(({ context, server, target }) => {
      if (!context || !server) return;
      const pathContext = `/${context}/`;
      const pathTarget = `/${target || context}`;
      console.log('########## proxy mapping', { context, server, target: pathTarget });
      router.use(pathContext, module.exports.forward(server, { path: pathTarget }));
    });

    module.exports.afterParser(router,{ bodyParser, customParser } );

    proxyFlags.on.ready({ appendRequestHeader });
    return router;
  },
  afterParser(apiRouter,{bodyParser}){
      apiRouter.use(bodyParser.urlencoded({limit: '50mb',extended: false}));
      apiRouter.use(bodyParser.json({limit: '50mb',extended: true}));
      apiRouter.use(bodyParser.text({limit: '50mb',extended: true}));
      apiRouter.use(bodyParser.raw({limit: '50mb'}));
  },
  setup(app) {
    loadProxyConfig().mappings.map(({ context, server, target }) => {
      if (!context || !server) return;
      const pathContext = `/${context}/`;
      const pathTarget = `/${target || context}`;
      console.log('########## proxy', { context, server, target: pathTarget });
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
      logger.debug('########## proxy', {
        from: `${req.method}:${req.protocol}://${req.headers.host}${req.originalUrl}`,
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
