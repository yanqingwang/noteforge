// jsdom 缺少的布局 API —— CM6 测量需要
if (typeof Range !== "undefined" && !(Range.prototype as any).getClientRects) {
  (Range.prototype as any).getClientRects = function () {
    const list: any = { length: 0, item: () => null };
    list[Symbol.iterator] = [][Symbol.iterator]();
    return list;
  };
  (Range.prototype as any).getBoundingClientRect = function () {
    return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON() {} };
  };
}
