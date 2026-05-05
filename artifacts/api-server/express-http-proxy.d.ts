declare module 'express-http-proxy' {
  import { RequestHandler } from 'express';
  
  interface ProxyOptions {
    proxyReqPathResolver?: (req: any) => string;
    userResDecorator?: (proxyRes: any, proxyResData: any, req: any, res: any) => any;
    [key: string]: any;
  }
  
  function proxy(host: string | ((req: any) => string), options?: ProxyOptions): RequestHandler;
  
  export default proxy;
}
