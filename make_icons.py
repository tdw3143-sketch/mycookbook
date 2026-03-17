"""
Generate PWA icons for MyCookbook using only the standard library.
Creates: static/icons/icon-192.png, icon-512.png, apple-touch-icon.png
"""
import os
import struct
import zlib

def make_png(size):
    """Return bytes of a square PNG with a green background and a white fork+knife."""
    w = h = size
    bg = (76, 175, 80)    # #4CAF50 green
    fg = (255, 255, 255)  # white

    # Build pixel grid
    pixels = [bg] * (w * h)

    def px(x, y, color):
        if 0 <= x < w and 0 <= y < h:
            pixels[y * w + x] = color

    def rect(x0, y0, x1, y1, color):
        for yy in range(y0, y1):
            for xx in range(x0, x1):
                px(xx, yy, color)

    def circle(cx, cy, r, color):
        for yy in range(cy - r, cy + r + 1):
            for xx in range(cx - r, cx + r + 1):
                if (xx - cx) ** 2 + (yy - cy) ** 2 <= r * r:
                    px(xx, yy, color)

    # Scale factor relative to 192px reference
    s = size / 192

    def sc(n):
        return max(1, round(n * s))

    # Draw a simple plate + steam icon
    cx = w // 2

    # Plate (ellipse approximated as circle + squish)
    plate_y = round(h * 0.62)
    plate_rx = sc(70)
    plate_ry = sc(18)
    for yy in range(plate_y - plate_ry, plate_y + plate_ry + 1):
        for xx in range(cx - plate_rx, cx + plate_rx + 1):
            dy = (yy - plate_y) / plate_ry if plate_ry else 0
            dx = (xx - cx) / plate_rx if plate_rx else 0
            if dx * dx + dy * dy <= 1:
                px(xx, yy, fg)

    # Bowl body
    bowl_top = round(h * 0.38)
    bowl_bot = plate_y
    bowl_w = sc(60)
    for yy in range(bowl_top, bowl_bot):
        t = (yy - bowl_top) / (bowl_bot - bowl_top)
        half = round(bowl_w * (0.5 + 0.5 * t))
        for xx in range(cx - half, cx + half + 1):
            px(xx, yy, fg)

    # Steam lines (3 wavy vertical lines)
    for offset in [-sc(16), 0, sc(16)]:
        sx = cx + offset
        for yy in range(round(h * 0.18), round(h * 0.34)):
            wave = round(sc(3) * ((yy // sc(6)) % 2 * 2 - 1))
            px(sx + wave, yy, fg)
            px(sx + wave + 1, yy, fg)

    # Encode as PNG
    def png_chunk(name, data):
        c = zlib.crc32(name + data) & 0xFFFFFFFF
        return struct.pack('>I', len(data)) + name + data + struct.pack('>I', c)

    raw_rows = b''
    for row in range(h):
        raw_rows += b'\x00'  # filter type None
        for col in range(w):
            r, g, b = pixels[row * w + col]
            raw_rows += bytes([r, g, b])

    compressed = zlib.compress(raw_rows, 9)

    png = (
        b'\x89PNG\r\n\x1a\n'
        + png_chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
        + png_chunk(b'IDAT', compressed)
        + png_chunk(b'IEND', b'')
    )
    return png


out_dir = os.path.join(os.path.dirname(__file__), 'static', 'icons')
os.makedirs(out_dir, exist_ok=True)

for filename, size in [
    ('icon-192.png', 192),
    ('icon-512.png', 512),
    ('apple-touch-icon.png', 180),
]:
    path = os.path.join(out_dir, filename)
    with open(path, 'wb') as f:
        f.write(make_png(size))
    print(f'Created {filename} ({size}x{size})')

print('Done — icons saved to static/icons/')
