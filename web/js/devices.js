// @license magnet:?xt=urn:btih:d3d9a9a6595521f9666a5e94cc830dab83b65699&dn=expat.txt MIT

// The devices this installer supports, by the product the bootloader reports
// ("getvar product") and an image set's build.json names. A new device is one
// entry here. The pages stay device-neutral and link to the website's supported
// devices page.
//
// name:   the device's name in messages.
// boot:   the button held while the phone starts, so that it stops in Fastboot Mode.
// force:  the buttons held to restart a running or stuck phone into Fastboot Mode.
export const DEVICES = Object.freeze({
    FP6: Object.freeze({ name: "Fairphone 6", boot: "Volume down", force: "Power and Volume down" }),
});

export const DEVICES_PAGE = "diamaneos.de/devices";

export function supported(product) {
    return typeof product === "string" && Object.hasOwn(DEVICES, product);
}

export function deviceName(product) {
    return supported(product) ? DEVICES[product].name : product;
}

// How to restart the phone into Fastboot Mode, from the data when the product is known.
export function restartHint(product) {
    return supported(product)
        ? `Hold ${DEVICES[product].force} until it restarts into Fastboot Mode.`
        : `Restart it into Fastboot Mode with its buttons, which ${DEVICES_PAGE} lists.`;
}

// What to hold while the phone restarts, so that it returns to Fastboot Mode.
export function bootHint(product) {
    return supported(product)
        ? `Hold ${DEVICES[product].boot} while it restarts`
        : `Use its Fastboot Mode button, which ${DEVICES_PAGE} lists, while it restarts`;
}

// @license-end
