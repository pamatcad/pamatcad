//! Orthographic, headless rendering of committed B-reps for scene.capture.
use crate::{
    error::{CoreError, ErrorCode, Result},
    kernel::Shape,
    protocol::CaptureScene,
};
use jpeg_encoder::{ColorType, Encoder};

type Point = [f64; 3];
type Triangle = [Point; 3];

fn dot(a: Point, b: Point) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn cross(a: Point, b: Point) -> Point {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}
fn minus(a: Point, b: Point) -> Point {
    std::array::from_fn(|i| a[i] - b[i])
}
fn unit(v: Point) -> Option<Point> {
    let length = v[0].hypot(v[1]).hypot(v[2]);
    (length.is_finite() && length > 0.).then(|| v.map(|n| n / length))
}
fn invalid(msg: &str) -> CoreError {
    CoreError::new(ErrorCode::InvalidParameter, msg)
}

pub fn jpeg(bodies: &[&Shape], request: &CaptureScene) -> Result<Vec<u8>> {
    let (width, height) = (request.width.unwrap_or(1200), request.height.unwrap_or(900));
    if !(1..=4096).contains(&width) || !(1..=4096).contains(&height) {
        return Err(invalid(
            "Image dimensions must be between 1 and 4096 pixels",
        ));
    }
    let options = request.camera.clone().unwrap_or_default();
    let padding = options.padding_px.unwrap_or(32);
    if 2 * u64::from(padding) >= u64::from(width.min(height)) {
        return Err(invalid("Camera padding leaves no drawable area"));
    }
    let target = options.target.unwrap_or([0.; 3]);
    if !target.iter().all(|v| v.is_finite()) {
        return Err(invalid("Camera target must be finite"));
    }
    let eye = unit(options.from_direction.unwrap_or([1.; 3]))
        .ok_or_else(|| invalid("Invalid camera direction"))?;
    let up = unit(options.up.unwrap_or([0., 0., 1.]))
        .ok_or_else(|| invalid("Invalid camera up vector"))?;
    let right = unit(cross(up, eye))
        .ok_or_else(|| invalid("Camera direction and up must be independent"))?;
    let vertical = cross(eye, right);

    let mut triangles = Vec::new();
    for body in bodies {
        body.mesh(&mut triangles)?;
    }
    let mut extent = [0_f64; 2];
    for p in triangles.iter_mut().flatten() {
        let d = minus(*p, target);
        *p = [dot(d, right), dot(d, vertical), dot(d, eye)];
        if !p.iter().all(|v| v.is_finite()) {
            return Err(invalid("Projected bounds are not finite"));
        }
        for i in 0..2 {
            extent[i] = extent[i].max(p[i].abs());
        }
    }
    let scale = ((width - 2 * padding) as f64 / (2. * extent[0]))
        .min((height - 2 * padding) as f64 / (2. * extent[1]));
    if !scale.is_finite() || scale <= 0. {
        return Err(invalid("Empty projected bounds"));
    }

    let mut image = Raster::new(width as usize, height as usize);
    for triangle in triangles {
        image.draw(triangle, scale);
    }
    if request.show_axes.unwrap_or(false) {
        let origin = image.screen(-dot(target, right), -dot(target, vertical), scale);
        image.draw_axes(origin, right, vertical);
    }
    let mut bytes = Vec::new();
    Encoder::new(&mut bytes, 90)
        .encode(&image.rgb, width as u16, height as u16, ColorType::Rgb)
        .map_err(|e| {
            CoreError::new(
                ErrorCode::KernelFailure,
                format!("JPEG encoding failed: {e}"),
            )
        })?;
    Ok(bytes)
}

struct Raster {
    width: usize,
    height: usize,
    rgb: Vec<u8>,
    depth: Vec<f64>,
}

type PixelPoint = [f64; 2];

impl Raster {
    fn new(width: usize, height: usize) -> Self {
        Self {
            width,
            height,
            rgb: [246, 248, 250].repeat(width * height),
            depth: vec![f64::NEG_INFINITY; width * height],
        }
    }

    fn screen(&self, x: f64, y: f64, scale: f64) -> PixelPoint {
        [
            self.width as f64 / 2. + x * scale,
            self.height as f64 / 2. - y * scale,
        ]
    }

    fn draw_axes(&mut self, origin: PixelPoint, right: Point, vertical: Point) {
        let size = self.width.min(self.height) as f64;
        let length = size * 0.12;
        let pen = (size / 420.).clamp(0.7, 6.);
        // Upright X, Y and Z labels in screen coordinates.
        let axes: [([u8; 3], &[[f64; 4]]); 3] = [
            ([181, 43, 45], &[[-0.7, -1., 0.7, 1.], [-0.7, 1., 0.7, -1.]]),
            (
                [22, 124, 66],
                &[[-0.7, -1., 0., 0.], [0.7, -1., 0., 0.], [0., 0., 0., 1.]],
            ),
            (
                [36, 82, 179],
                &[
                    [-0.7, -1., 0.7, -1.],
                    [0.7, -1., -0.7, 1.],
                    [-0.7, 1., 0.7, 1.],
                ],
            ),
        ];
        for (i, (color, glyph)) in axes.iter().enumerate() {
            let dx = right[i];
            let dy = -vertical[i];
            let projected = dx.hypot(dy);
            let tip = [origin[0] + length * dx, origin[1] + length * dy];
            // A view along an axis projects it to the origin. Offset its label diagonally.
            let (ux, uy) = if projected > 1e-8 {
                (dx / projected, dy / projected)
            } else {
                (
                    std::f64::consts::FRAC_1_SQRT_2,
                    -std::f64::consts::FRAC_1_SQRT_2,
                )
            };
            let label = [tip[0] + ux * pen * 10., tip[1] + uy * pen * 10.];
            for (ink, radius) in [([255; 3], pen * 1.85), (*color, pen)] {
                self.stroke(origin, tip, radius, ink);
                let head = (length * projected * 0.4).min(6. * pen);
                for side in [-0.45, 0.45] {
                    let wing = [
                        tip[0] - head * (ux + side * uy),
                        tip[1] - head * (uy - side * ux),
                    ];
                    self.stroke(wing, tip, radius, ink);
                }
                let letter_point = |x, y| [label[0] + x * pen * 6., label[1] + y * pen * 6.];
                for &[x1, y1, x2, y2] in *glyph {
                    self.stroke(letter_point(x1, y1), letter_point(x2, y2), radius, ink);
                }
            }
        }
        self.stroke(origin, origin, pen * 3., [255; 3]);
        self.stroke(origin, origin, pen * 1.8, [37, 46, 54]);
    }

    // Paint a round-ended stroke, clipping its pixel bounds to the image.
    fn stroke(&mut self, a: PixelPoint, b: PixelPoint, radius: f64, color: [u8; 3]) {
        let [dx, dy] = [b[0] - a[0], b[1] - a[1]];
        let squared = dx * dx + dy * dy;
        let bounds = |start: f64, end: f64, limit| {
            let lo = (start.min(end) - radius - 1.).floor() as usize;
            let hi = (start.max(end) + radius + 1.).ceil() as usize;
            lo..hi.min(limit)
        };
        let columns = bounds(a[0], b[0], self.width);
        for y in bounds(a[1], b[1], self.height) {
            for x in columns.clone() {
                let px = x as f64 + 0.5 - a[0];
                let py = y as f64 + 0.5 - a[1];
                let t = if squared == 0. {
                    0.
                } else {
                    ((px * dx + py * dy) / squared).clamp(0., 1.)
                };
                let coverage = (radius + 0.5 - (px - t * dx).hypot(py - t * dy)).clamp(0., 1.);
                let index = 3 * (y * self.width + x);
                for (dst, src) in self.rgb[index..index + 3].iter_mut().zip(color) {
                    *dst = (f64::from(*dst) + coverage * (f64::from(src) - f64::from(*dst))).round()
                        as u8;
                }
            }
        }
    }

    fn draw(&mut self, tri: Triangle, scale: f64) {
        let [a, b, c] = tri;
        let normal = cross(minus(b, a), minus(c, a));
        if normal[2] <= 0. {
            return;
        }
        let normal = match unit(normal) {
            Some(n) => n,
            None => return,
        };
        let light = 0.51 + 0.49 * dot(normal, [-0.44, 0.69, 0.57]).max(0.);
        let color = [115., 161., 188.].map(|v| (v * light).round() as u8);
        let points = tri.map(|[x, y, z]| {
            let [px, py] = self.screen(x, y, scale);
            [px, py, z]
        });
        let [a, b, c] = points;
        let edge = |a: Point, b: Point, x: f64, y: f64| {
            (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0])
        };
        let area = edge(a, b, c[0], c[1]);
        if area == 0. {
            return;
        }
        let x_min = a[0].min(b[0]).min(c[0]).floor() as usize;
        let y_min = a[1].min(b[1]).min(c[1]).floor() as usize;
        let x_max = (a[0].max(b[0]).max(c[0]).ceil() as usize).min(self.width);
        let y_max = (a[1].max(b[1]).max(c[1]).ceil() as usize).min(self.height);
        for y in y_min..y_max {
            for x in x_min..x_max {
                let (px, py) = (x as f64 + 0.5, y as f64 + 0.5);
                let u = edge(b, c, px, py) / area;
                let v = edge(c, a, px, py) / area;
                let w = 1. - u - v;
                if u.min(v).min(w) < -1e-10 {
                    continue;
                }
                let z = u * a[2] + v * b[2] + w * c[2];
                let i = y * self.width + x;
                if z > self.depth[i] {
                    self.depth[i] = z;
                    self.rgb[3 * i..3 * i + 3].copy_from_slice(&color);
                }
            }
        }
    }
}
