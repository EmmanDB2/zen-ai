// Screenshot sizes Claude can point at (shotRatio) and the close-up on an
// approval card (cropAround). Pure, no browser.
import { checker, crash } from "../helpers/common.mjs";
import { cropAround, shotRatio } from "../../src/pages.mjs";
import { SCREENSHOT_MAX_EDGE, SCREENSHOT_MAX_PIXELS } from "../../src/config.mjs";

const { check, done } = checker();

try {
  // shotRatio: small enough that Anthropic doesn't resize it (that would move Claude's points)
  check("a laptop-sized page is kept at 1:1", shotRatio(1280, 800) === 1 && shotRatio(1024, 768) === 1);
  for (const [w, h] of [[1800, 1100], [2560, 1400], [3000, 600], [600, 3000]]) {
    const r = shotRatio(w, h);
    const W = Math.round(w * r);
    const H = Math.round(h * r);
    check(`${w}×${h} shrinks to ${W}×${H}: within the edge and pixel limits`, r < 1 && Math.max(W, H) <= SCREENSHOT_MAX_EDGE && W * H <= SCREENSHOT_MAX_PIXELS * 1.002, { r, W, H });
  }

  // cropAround: a 2:1 box around the marks, inside the image
  const inside = (b, w, h) => b.x >= 0 && b.y >= 0 && b.x + b.w <= w && b.y + b.h <= h;
  const has = (b, m) => m.x >= b.x && m.x <= b.x + b.w && m.y >= b.y && m.y <= b.y + b.h;
  let b = cropAround([{ x: 500, y: 400 }], 1280, 800);
  check("one point: a 320×160 box centred on it", b.w === 320 && b.h === 160 && b.x === 340 && b.y === 320, b);
  b = cropAround([{ x: 5, y: 790 }], 1280, 800);
  check("a point in a corner: the box stays inside the image", inside(b, 1280, 800) && has(b, { x: 5, y: 790 }), b);
  const drag = [{ x: 257, y: 465 }, { x: 182, y: 465 }];
  b = cropAround(drag, 1280, 800);
  check("a short drag: both ends with room around them", drag.every((m) => has(b, m)) && b.x <= 182 - 60 && b.x + b.w >= 257 + 60 && b.w === 2 * b.h, b);
  const long = [{ x: 100, y: 100 }, { x: 1100, y: 140 }];
  b = cropAround(long, 1280, 800);
  check("a long drag: the box widens to hold both", long.every((m) => has(b, m)) && inside(b, 1280, 800), b);
  const tall = [{ x: 600, y: 80 }, { x: 610, y: 700 }];
  b = cropAround(tall, 1280, 800);
  check("a tall drag: up to a square, both ends in", tall.every((m) => has(b, m)) && b.w === b.h && inside(b, 1280, 800), b);
  b = cropAround([{ x: 50, y: 50 }], 200, 120);
  check("an image smaller than the box: the whole image", b.x === 0 && b.y === 0 && b.w === 200 && b.h === 120, b);
} catch (e) {
  crash(e);
}
done();
