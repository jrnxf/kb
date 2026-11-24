// The site is static: this Worker only sends plain HTTP to HTTPS, and hands every other request to the assets.
// The `ASSETS` binding serves dist/ with the rules of dist/_headers, so HSTS, Link and caching stay in build.ts.
export default {
  async fetch(request: Request, env: { ASSETS: Fetcher }): Promise<Response> {
    const url = new URL(request.url);
    if (url.protocol === "http:") {
      url.protocol = "https:";
      return Response.redirect(url.toString(), 301);
    }
    return env.ASSETS.fetch(request);
  },
};
