'use strict';

// Usage: electron tools/make-icon.js <path-to-idle_sprite_cell1024x1536.png>
// Writes build/icon.png (256x256) cropped around the face of the first idle frame.
const { app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

app.whenReady().then(() => {
  const source = process.argv[process.argv.length - 1];
  const sprite = nativeImage.createFromPath(source);
  if (sprite.isEmpty()) {
    console.error(`Cannot read ${source}`);
    app.exit(1);
    return;
  }
  const scale = sprite.getSize().width / 2048;
  const crop = sprite.crop({
    x: Math.round(214 * scale),
    y: Math.round(34 * scale),
    width: Math.round(112 * scale),
    height: Math.round(112 * scale)
  });
  const out = path.join(__dirname, '..', 'build', 'icon.png');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, crop.resize({ width: 256, height: 256, quality: 'best' }).toPNG());
  console.log(`wrote ${out}`);
  app.exit(0);
});
