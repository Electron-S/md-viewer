# 앱 아이콘(host/app.ico) 생성: 둥근 사각형 위 "M↓" (Markdown 표식). 한 번만 돌리면 된다.
from PIL import Image, ImageDraw

def draw(size: int) -> Image.Image:
    s = size * 4
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = s // 6
    d.rounded_rectangle([s * 0.04, s * 0.14, s * 0.96, s * 0.86], radius=r, fill=(11, 99, 206, 255))
    w = s * 0.07
    # M
    x0, x1, y0, y1 = s * 0.17, s * 0.53, s * 0.32, s * 0.70
    d.line([(x0, y1), (x0, y0), ((x0 + x1) / 2, (y0 + y1) / 2 + s * 0.02), (x1, y0), (x1, y1)], fill='white', width=int(w), joint='curve')
    # ↓
    ax = s * 0.72
    d.line([(ax, y0), (ax, y1 - s * 0.06)], fill='white', width=int(w))
    d.polygon([(ax - s * 0.11, y1 - s * 0.13), (ax + s * 0.11, y1 - s * 0.13), (ax, y1 + s * 0.02)], fill='white')
    return img.resize((size, size), Image.LANCZOS)

sizes = [16, 24, 32, 48, 64, 128, 256]
imgs = [draw(n) for n in sizes]
imgs[-1].save('host/app.ico', sizes=[(n, n) for n in sizes], append_images=imgs[:-1])
print('host/app.ico')
