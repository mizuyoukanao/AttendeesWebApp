declare module "html5-qrcode/third_party/zxing-js.umd.js" {
  export class BrowserQRCodeSvgWriter {
    write(contents: string, width: number, height: number, hints?: Map<unknown, unknown> | null): SVGElement;
  }
}
