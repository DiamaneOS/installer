// @license magnet:?xt=urn:btih:d3d9a9a6595521f9666a5e94cc830dab83b65699&dn=expat.txt MIT

// Staging serves the same files as production. There, the website links lead to the staging website.
const SITE = "https://diamaneos.de/";
if (location.hostname === "install.staging.diamaneos.de") {
    for (const link of document.querySelectorAll(`a[href^="${SITE}"]`)) {
        link.href = "https://staging.diamaneos.de/" + link.getAttribute("href").slice(SITE.length);
    }
}

// @license-end
