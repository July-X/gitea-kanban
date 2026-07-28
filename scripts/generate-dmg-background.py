#!/usr/bin/env python3
"""生成 macOS DMG 安装窗口背景图（PNG，无第三方依赖）。"""

from __future__ import annotations

import struct
import sys
import zlib
from pathlib import Path

WIDTH = 660
HEIGHT = 420


def chunk(kind: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)


def set_pixel(canvas: bytearray, x: int, y: int, color: tuple[int, int, int, int]) -> None:
    if not (0 <= x < WIDTH and 0 <= y < HEIGHT):
        return
    offset = (y * WIDTH + x) * 4
    canvas[offset : offset + 4] = bytes(color)


def blend_pixel(canvas: bytearray, x: int, y: int, color: tuple[int, int, int, int]) -> None:
    if not (0 <= x < WIDTH and 0 <= y < HEIGHT):
        return
    offset = (y * WIDTH + x) * 4
    alpha = color[3] / 255
    for channel in range(3):
        canvas[offset + channel] = round(canvas[offset + channel] * (1 - alpha) + color[channel] * alpha)


def disc(canvas: bytearray, cx: int, cy: int, radius: int, color: tuple[int, int, int, int]) -> None:
    radius_sq = radius * radius
    for y in range(cy - radius, cy + radius + 1):
        for x in range(cx - radius, cx + radius + 1):
            if (x - cx) ** 2 + (y - cy) ** 2 <= radius_sq:
                blend_pixel(canvas, x, y, color)


def line(canvas: bytearray, start: tuple[int, int], end: tuple[int, int], width: int, color: tuple[int, int, int, int]) -> None:
    x0, y0 = start
    x1, y1 = end
    steps = max(abs(x1 - x0), abs(y1 - y0), 1)
    for index in range(steps + 1):
        t = index / steps
        disc(canvas, round(x0 + (x1 - x0) * t), round(y0 + (y1 - y0) * t), width // 2, color)


def bezier(canvas: bytearray, points: tuple[tuple[int, int], ...], width: int, color: tuple[int, int, int, int]) -> None:
    p0, p1, p2, p3 = points
    previous = p0
    for index in range(1, 101):
        t = index / 100
        inverse = 1 - t
        current = (
            round(inverse**3 * p0[0] + 3 * inverse**2 * t * p1[0] + 3 * inverse * t**2 * p2[0] + t**3 * p3[0]),
            round(inverse**3 * p0[1] + 3 * inverse**2 * t * p1[1] + 3 * inverse * t**2 * p2[1] + t**3 * p3[1]),
        )
        line(canvas, previous, current, width, color)
        previous = current


def draw_glyph(canvas: bytearray, glyph: tuple[str, ...], x: int, y: int, scale: int, color: tuple[int, int, int, int]) -> None:
    for row, data in enumerate(glyph):
        for column, value in enumerate(data):
            if value == "1":
                for dy in range(scale):
                    for dx in range(scale):
                        set_pixel(canvas, x + column * scale + dx, y + row * scale + dy, color)


GLYPHS = {
    "D": ("11110", "10001", "10001", "10001", "10001", "10001", "11110"),
    "R": ("11110", "10001", "10001", "11110", "10100", "10010", "10001"),
    "A": ("01110", "10001", "10001", "11111", "10001", "10001", "10001"),
    "G": ("01110", "10001", "10000", "10111", "10001", "10001", "01110"),
    "T": ("11111", "00100", "00100", "00100", "00100", "00100", "00100"),
    "O": ("01110", "10001", "10001", "10001", "10001", "10001", "01110"),
    "I": ("11111", "00100", "00100", "00100", "00100", "00100", "11111"),
    "N": ("10001", "11001", "10101", "10101", "10011", "10001", "10001"),
    "S": ("01111", "10000", "10000", "01110", "00001", "00001", "11110"),
    "L": ("10000", "10000", "10000", "10000", "10000", "10000", "11111"),
    "F": ("11111", "10000", "10000", "11110", "10000", "10000", "10000"),
    "E": ("11111", "10000", "10000", "11110", "10000", "10000", "11111"),
    "P": ("11110", "10001", "10001", "11110", "10000", "10000", "10000"),
    "C": ("01111", "10000", "10000", "10000", "10000", "10000", "01111"),
    " ": ("000",) * 7,
}


def text_width(text: str, scale: int) -> int:
    return sum((len(GLYPHS[character][0]) + 1) * scale for character in text) - scale


def draw_text(canvas: bytearray, text: str, center_x: int, y: int, scale: int, color: tuple[int, int, int, int]) -> None:
    unsupported = sorted(set(text) - set(GLYPHS))
    if unsupported:
        raise ValueError(f"unsupported glyphs: {unsupported}")
    x = center_x - text_width(text, scale) // 2
    for character in text:
        glyph = GLYPHS[character]
        draw_glyph(canvas, glyph, x, y, scale, color)
        x += (len(glyph[0]) + 1) * scale


def write_png(path: Path, canvas: bytearray) -> None:
    raw = bytearray()
    stride = WIDTH * 4
    for y in range(HEIGHT):
        raw.append(0)
        raw.extend(canvas[y * stride : (y + 1) * stride])
    signature = b"\x89PNG\r\n\x1a\n"
    header = struct.pack(">IIBBBBB", WIDTH, HEIGHT, 8, 6, 0, 0, 0)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(signature + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b""))


def main() -> None:
    output = Path(sys.argv[1] if len(sys.argv) > 1 else "build/darwin/dmg-background.png")
    canvas = bytearray((247, 249, 251, 255) * WIDTH * HEIGHT)

    # 顶部极淡蓝绿色光晕延续应用的 Gitea 绿色，同时保持 Finder 原生观感。
    for radius in range(250, 20, -1):
        alpha = max(0, round((250 - radius) / 230 * 0.12))
        if alpha:
            disc(canvas, WIDTH // 2, 42, radius, (116, 184, 48, alpha))

    # 弧形箭头位于两个 Finder 图标之间；图标本身由 Finder 按坐标渲染。
    arrow = (49, 56, 63, 220)
    bezier(canvas, ((270, 173), (304, 130), (356, 130), (390, 173)), 7, arrow)
    line(canvas, (390, 173), (369, 163), 7, arrow)
    line(canvas, (390, 173), (380, 151), 7, arrow)

    # Finder 不可靠显示中文背景字体，因此背景只绘制清晰英文提示；中文说明保留在构建注释和 README。
    draw_text(canvas, "DRAG TO INSTALL", WIDTH // 2, 292, 3, (31, 39, 46, 255))
    draw_text(canvas, "DRAG TO APPLICATIONS FOLDER", WIDTH // 2, 329, 2, (102, 112, 122, 255))

    write_png(output, canvas)
    print(output)


if __name__ == "__main__":
    main()
