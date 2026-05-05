# trynProxy - Newest and most advanced proxy, by Cleann.

|-------------------------------------------------------------------------------------------------------|
|                            We are going to start off with a list of features.                         |
---------------------------------------------------------------------------------------------------------
| Proxied Websocket Connections.    | Allows Tryn to bypass even the most Secure Filters                |
| CloudFlare worker Secondary Proxy.| Tells filters that Tryn's connections are just cloudflare packets.|
| <400ms Load times                 | We all know ts is needed.                                         |
| Active Development                | Multiple updates arriving soon. Stay tuned.                       |
| Lightweight Architecture          | Minimal resource consumption while maintaining full functionality |
| Cross-Browser Support             | Works on Chrome, Firefox, Edge, and all major browsers            |
---------------------------------------------------------------------------------------------------------

trynProxy uses advanced tunneling techniques to maintain high-speed connections while bypassing network restrictions. The dual-layer architecture combines direct proxying with Cloudflare Worker routing for maximum reliability.

Getting Started:

git clone https://github.com/Cleann444/trynProxy.git
cd trynProxy
npm install
npm start

The proxy will launch on port 8080 by default. Configure your browser to use localhost:8080 as the proxy address.

Deployment:
This proxy is optimized for Cloudflare Workers deployment but can run on any Node.js environment. For production deployment, run npm run deploy and follow the Cloudflare authentication prompts.

Requirements:
- Node.js 18 or higher
- npm or yarn package manager
- Cloudflare account (optional, for Worker deployment)

Future Updates:
The development roadmap includes WebSocket pooling, additional protocol support, and enhanced filter evasion techniques. Check the repository weekly for updates.

Made with love by Cleann

(c) 2026 Tryn Stealth Proxies - All Rights Reserved.
