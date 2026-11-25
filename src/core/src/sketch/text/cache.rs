use super::{invalid, Outline};
use crate::{error::Result, kernel::sketch::normalize_text, sketch::LINEAR_TOLERANCE};
use std::{collections::BTreeMap, rc::Rc};

type Curves = Vec<(i32, Vec<f64>)>;
struct Entry {
    curves: Rc<Curves>,
    bytes: usize,
    used: u64,
}

// Engine-owned derived data, shared by transaction/preview snapshots. Keys are
// exact scaled outlines, not font names or hashes; font variations and sizes
// therefore cannot collide. No model references or native handles are retained.
pub(crate) struct GlyphCache {
    entries: BTreeMap<Vec<u64>, Entry>,
    bytes: usize,
    budget: usize,
    clock: u64,
}
impl Default for GlyphCache {
    fn default() -> Self {
        Self {
            entries: BTreeMap::new(),
            bytes: 0,
            budget: 8 * 1024 * 1024,
            clock: 0,
        }
    }
}
impl GlyphCache {
    fn normalize(&mut self, outline: &Outline) -> Result<(Rc<Curves>, bool)> {
        let mut key = vec![LINEAR_TOLERANCE.to_bits()];
        for segment in &outline.segments {
            key.push(segment.len() as u64);
            key.extend(segment.iter().flatten().map(|v| v.to_bits()));
        }
        self.clock += 1;
        if let Some(entry) = self.entries.get_mut(&key) {
            entry.used = self.clock;
            return Ok((entry.curves.clone(), true));
        }
        let curves = Rc::new(normalize_text(&outline.segments)?);
        // Include capacities and an allowance for each map node; the entry cap
        // also bounds allocator/container overhead independently of curve size.
        let bytes = key.capacity() * 8
            + std::mem::size_of::<Entry>()
            + 128
            + curves.capacity() * std::mem::size_of::<(i32, Vec<f64>)>()
            + curves
                .iter()
                .map(|(_, data)| data.capacity() * 8)
                .sum::<usize>();
        if bytes <= self.budget {
            while self.bytes + bytes > self.budget || self.entries.len() >= 4096 {
                let oldest = self
                    .entries
                    .iter()
                    .min_by_key(|(_, e)| e.used)
                    .unwrap()
                    .0
                    .clone();
                self.bytes -= self.entries.remove(&oldest).unwrap().bytes;
            }
            self.bytes += bytes;
            self.entries.insert(
                key,
                Entry {
                    curves: curves.clone(),
                    bytes,
                    used: self.clock,
                },
            );
        }
        Ok((curves, false))
    }
}

pub(super) struct PlacedGlyph {
    pub outline: Rc<Outline>,
    pub origin: [f64; 2],
    pub angle: f64,
}
impl PlacedGlyph {
    fn point(&self, [x, y]: [f64; 2]) -> [f64; 2] {
        let (s, c) = self.angle.sin_cos();
        [
            self.origin[0] + x * c - y * s,
            self.origin[1] + x * s + y * c,
        ]
    }
    fn curve(&self, kind: i32, data: &[f64]) -> Result<(i32, Vec<f64>)> {
        let mut data = data.to_vec();
        let coordinates = match kind {
            1 => &mut data[..4],
            2 | 3 => {
                if kind == 3 {
                    data[3] += self.angle;
                    data[4] += self.angle;
                }
                &mut data[..2]
            }
            4 => {
                let n = data[1] as usize;
                &mut data[4..4 + 2 * n]
            }
            _ => return Err(invalid("Unknown normalized glyph curve")),
        };
        for xy in coordinates.chunks_exact_mut(2) {
            xy.copy_from_slice(&self.point([xy[0], xy[1]]));
        }
        Ok((kind, data))
    }
}

pub(super) fn normalize_glyphs(
    glyphs: &[PlacedGlyph],
    cache: &mut GlyphCache,
) -> Result<(Curves, usize, usize, usize)> {
    // Control-point hulls contain every Bezier. Merge aggregate bounds to a
    // fixed point, also retaining nested and tolerance-touching glyphs together.
    let mut groups: Vec<(Vec<usize>, [[f64; 2]; 2])> = vec![];
    for (index, glyph) in glyphs.iter().enumerate() {
        if glyph.outline.segments.is_empty() {
            continue;
        }
        let mut bounds = [[f64::INFINITY; 2], [f64::NEG_INFINITY; 2]];
        for p in glyph.outline.segments.iter().flatten() {
            let p = glyph.point(*p);
            for axis in 0..2 {
                bounds[0][axis] = bounds[0][axis].min(p[axis] - LINEAR_TOLERANCE);
                bounds[1][axis] = bounds[1][axis].max(p[axis] + LINEAR_TOLERANCE);
            }
        }
        let mut members = vec![index];
        let mut i = 0;
        while i < groups.len() {
            let other = groups[i].1;
            if (0..2)
                .all(|axis| bounds[0][axis] <= other[1][axis] && other[0][axis] <= bounds[1][axis])
            {
                let (indices, _) = groups.remove(i);
                members.extend(indices);
                for axis in 0..2 {
                    bounds[0][axis] = bounds[0][axis].min(other[0][axis]);
                    bounds[1][axis] = bounds[1][axis].max(other[1][axis]);
                }
                i = 0;
            } else {
                i += 1;
            }
        }
        members.sort_unstable();
        groups.push((members, bounds));
    }
    groups.sort_by_key(|(members, _)| members[0]);
    let (mut output, mut hits, mut misses, mut overlaps) = (vec![], 0, 0, 0);
    for (members, _) in groups {
        if members.len() == 1 {
            let glyph = &glyphs[members[0]];
            let (curves, hit) = cache.normalize(&glyph.outline)?;
            if hit {
                hits += 1;
            } else {
                misses += 1;
            }
            for (kind, data) in curves.iter() {
                output.push(glyph.curve(*kind, data)?);
            }
        } else {
            overlaps += 1;
            let mut outlines = vec![];
            for index in members {
                let glyph = &glyphs[index];
                outlines.extend(
                    glyph
                        .outline
                        .segments
                        .iter()
                        .map(|segment| segment.iter().map(|p| glyph.point(*p)).collect()),
                );
            }
            // Preserve original winding across glyphs; independently normalized
            // contours cannot safely replace the originals in an overlap group.
            output.extend(normalize_text(&outlines)?);
        }
    }
    Ok((output, hits, misses, overlaps))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn square(size: f64) -> Rc<Outline> {
        let points = [[0., 0.], [size, 0.], [size, size], [0., size], [0., 0.]];
        Rc::new(Outline {
            segments: points.windows(2).map(|p| p.to_vec()).collect(),
            ..Outline::default()
        })
    }
    #[test]
    fn glyph_cache_evicts_least_recently_used_and_bypasses_oversized_entries() {
        let mut cache = GlyphCache::default();
        let a = square(1.);
        let b = square(2.);
        let c = square(3.);
        let first = cache.normalize(&a).unwrap().0;
        cache.normalize(&b).unwrap();
        cache.budget = cache.bytes;
        assert!(cache.normalize(&a).unwrap().1);
        assert!(!cache.normalize(&c).unwrap().1);
        assert_eq!(cache.entries.len(), 2);
        assert!(cache.normalize(&a).unwrap().1);
        assert!(!cache.normalize(&b).unwrap().1);
        assert!(cache.bytes <= cache.budget);
        let mut bypass = GlyphCache {
            budget: 1,
            ..GlyphCache::default()
        };
        assert_eq!(*bypass.normalize(&a).unwrap().0, *first);
        assert!(!bypass.normalize(&a).unwrap().1);
        assert!(bypass.entries.is_empty());
        assert_eq!(bypass.bytes, 0);
    }
    #[test]
    fn repeated_glyphs_normalize_once_and_place_every_copy() {
        let mut cache = GlyphCache::default();
        let outline = square(3.);
        let glyphs: Vec<_> = (0..14)
            .map(|i| PlacedGlyph {
                outline: outline.clone(),
                origin: [i as f64 * 5., 0.],
                angle: 0.,
            })
            .collect();
        let (cold, hits, misses, overlaps) = normalize_glyphs(&glyphs, &mut cache).unwrap();
        assert_eq!((hits, misses, overlaps), (13, 1, 0));
        assert_eq!(cold.len(), 56);
        let (warm, hits, misses, overlaps) = normalize_glyphs(&glyphs, &mut cache).unwrap();
        assert_eq!((hits, misses, overlaps), (14, 0, 0));
        assert_eq!(cold, warm);
        let mut all = vec![];
        for glyph in &glyphs {
            all.extend(
                glyph
                    .outline
                    .segments
                    .iter()
                    .map(|s| s.iter().map(|p| glyph.point(*p)).collect()),
            );
        }
        assert_eq!(cold, normalize_text(&all).unwrap());
    }
    #[test]
    fn overlapping_glyphs_use_original_joint_winding_even_with_a_warm_cache() {
        let a = square(3.);
        let mut cache = GlyphCache::default();
        cache.normalize(&a).unwrap();
        // Identical contours with opposite winding cancel. Independent unions
        // would incorrectly leave a filled square.
        let reversed = Rc::new(Outline {
            segments: a
                .segments
                .iter()
                .rev()
                .map(|p| p.iter().rev().copied().collect())
                .collect(),
            ..Outline::default()
        });
        let glyphs = [
            PlacedGlyph {
                outline: a,
                origin: [0., 0.],
                angle: 0.,
            },
            PlacedGlyph {
                outline: reversed,
                origin: [0., 0.],
                angle: 0.,
            },
        ];
        let (curves, hits, misses, overlaps) = normalize_glyphs(&glyphs, &mut cache).unwrap();
        assert!(curves.is_empty());
        assert_eq!((hits, misses, overlaps), (0, 0, 1));
        let separate = [
            PlacedGlyph {
                outline: square(3.),
                origin: [0., 0.],
                angle: 0.,
            },
            PlacedGlyph {
                outline: square(3.),
                origin: [5., 0.],
                angle: 0.,
            },
        ];
        let (curves, hits, misses, overlaps) = normalize_glyphs(&separate, &mut cache).unwrap();
        assert_eq!(curves.len(), 8);
        assert_eq!((hits, misses, overlaps), (2, 0, 0));
    }
}
