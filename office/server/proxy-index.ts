import { createTududiProxy, proxyConfig } from './tududi-proxy.js';
const config = proxyConfig();
createTududiProxy().listen(config.port,config.host);
