use super::Shape;
use crate::{
    error::{CoreError, ErrorCode, Result},
    protocol::SketchGeometry,
    sketch::Sketch,
};
use std::{
    cell::OnceCell,
    ffi::{c_char, c_void, CStr},
    ops::Bound::{Included, Unbounded},
    ptr::NonNull,
    rc::Rc,
};
#[repr(C)]
struct Curve {
    kind: i32,
    start: usize,
    count: usize,
}
#[derive(Clone)]
pub(crate) struct Profile {
    pub shape: Rc<Shape>,
    pub edges: Vec<String>,
    pub signature: String,
    loops: Rc<OnceCell<Vec<Vec<[f64; 3]>>>>,
}
extern "C" {
    fn pamat_sketch_profile_proxy(
        shape: *const c_void,
        sink: extern "C" fn(*mut c_void, *const f64, usize),
        context: *mut c_void,
        error: *mut c_char,
        error_size: usize,
    ) -> i32;
    fn pamat_sketch_regions(
        frame: *const f64,
        curves: *const Curve,
        count: usize,
        data: *const f64,
        sink: extern "C" fn(*mut c_void, *mut c_void, *const usize, *const i32, usize),
        context: *mut c_void,
        error: *mut c_char,
        error_size: usize,
    ) -> i32;
}
pub(crate) fn regions(sketch: &Sketch, selected: &[String]) -> Result<Vec<Profile>> {
    let (curves, data, ids) = encode_curves(sketch, Some(selected))?;
    struct Context {
        profiles: Vec<Profile>,
        ids: Vec<String>,
    }
    extern "C" fn receive(
        context: *mut c_void,
        shape: *mut c_void,
        sources: *const usize,
        orientations: *const i32,
        count: usize,
    ) {
        let context = unsafe { &mut *context.cast::<Context>() };
        let sources = unsafe { std::slice::from_raw_parts(sources, count) };
        let orientations = unsafe { std::slice::from_raw_parts(orientations, count) };
        let edges = sources
            .iter()
            .map(|i| context.ids[*i].clone())
            .collect::<Vec<_>>();
        let mut signature = edges
            .iter()
            .zip(orientations)
            .map(|(id, o)| format!("{id}:{o}"))
            .collect::<Vec<_>>();
        signature.sort();
        context.profiles.push(Profile {
            shape: Rc::new(Shape::from_raw(
                NonNull::new(shape).expect("OCCT profile handle"),
            )),
            edges,
            signature: signature.join("/"),
            loops: Rc::new(OnceCell::new()),
        });
    }
    let frame = [
        sketch.frame.origin,
        sketch.frame.u,
        sketch.frame.v,
        sketch.frame.normal,
    ]
    .concat();
    let mut context = Context {
        profiles: vec![],
        ids,
    };
    let mut error = [0; 1024];
    let status = unsafe {
        pamat_sketch_regions(
            frame.as_ptr(),
            curves.as_ptr(),
            curves.len(),
            data.as_ptr(),
            receive,
            (&mut context as *mut Context).cast(),
            error.as_mut_ptr(),
            error.len(),
        )
    };
    if status != 0 {
        return Err(CoreError::new(
            ErrorCode::KernelFailure,
            unsafe { CStr::from_ptr(error.as_ptr()) }
                .to_string_lossy()
                .into_owned(),
        ));
    }
    sort_profiles(&mut context.profiles);
    Ok(context.profiles)
}
pub(crate) fn sort_profiles(profiles: &mut [Profile]) {
    let first_source = |profile: &Profile| {
        profile
            .edges
            .iter()
            .filter_map(|id| {
                id.trim_start_matches(|c: char| !c.is_ascii_digit())
                    .parse::<u64>()
                    .ok()
            })
            .min()
            .unwrap_or(u64::MAX)
    };
    profiles.sort_by(|a, b| {
        first_source(a)
            .cmp(&first_source(b))
            .then_with(|| a.signature.cmp(&b.signature))
    });
}
extern "C" {
    fn pamat_sketch_groups(
        frame: *const f64,
        curves: *const Curve,
        count: usize,
        data: *const f64,
        sink: extern "C" fn(*mut c_void, *const usize, usize),
        context: *mut c_void,
        error: *mut c_char,
        error_size: usize,
    ) -> i32;
}
pub(crate) fn region_groups(sketch: &Sketch) -> Result<Vec<Vec<String>>> {
    let (curves, data, ids) = encode(sketch, None)?;
    extern "C" fn receive(context: *mut c_void, indices: *const usize, count: usize) {
        let output = unsafe { &mut *context.cast::<Vec<Vec<usize>>>() };
        output.push(unsafe { std::slice::from_raw_parts(indices, count) }.to_vec());
    }
    let frame = [
        sketch.frame.origin,
        sketch.frame.u,
        sketch.frame.v,
        sketch.frame.normal,
    ]
    .concat();
    let mut groups: Vec<Vec<usize>> = vec![];
    let mut error = [0; 1024];
    let status = unsafe {
        pamat_sketch_groups(
            frame.as_ptr(),
            curves.as_ptr(),
            curves.len(),
            data.as_ptr(),
            receive,
            (&mut groups as *mut Vec<Vec<usize>>).cast(),
            error.as_mut_ptr(),
            error.len(),
        )
    };
    if status != 0 {
        return Err(CoreError::new(
            ErrorCode::KernelFailure,
            unsafe { CStr::from_ptr(error.as_ptr()) }
                .to_string_lossy()
                .into_owned(),
        ));
    }
    Ok(groups
        .into_iter()
        .map(|group| group.into_iter().map(|i| ids[i].clone()).collect())
        .collect())
}

impl Profile {
    pub fn loops(&self) -> Result<Vec<Vec<[f64; 3]>>> {
        if let Some(loops) = self.loops.get() {
            return Ok(loops.clone());
        }
        extern "C" fn receive(context: *mut c_void, points: *const f64, count: usize) {
            let output = unsafe { &mut *context.cast::<Vec<Vec<[f64; 3]>>>() };
            let points = unsafe { std::slice::from_raw_parts(points, count * 3) };
            output.push(points.chunks_exact(3).map(|p| [p[0], p[1], p[2]]).collect());
        }
        let mut output: Vec<Vec<[f64; 3]>> = vec![];
        let mut error = [0; 1024];
        let status = unsafe {
            pamat_sketch_profile_proxy(
                self.shape.raw.as_ptr(),
                receive,
                (&mut output as *mut Vec<Vec<[f64; 3]>>).cast(),
                error.as_mut_ptr(),
                error.len(),
            )
        };
        if status != 0 {
            return Err(CoreError::new(
                ErrorCode::KernelFailure,
                unsafe { CStr::from_ptr(error.as_ptr()) }
                    .to_string_lossy()
                    .into_owned(),
            ));
        }
        let _ = self.loops.set(output.clone());
        Ok(output)
    }
}
extern "C" {
    fn pamat_sketch_project(
        body: *const c_void,
        kind: i32,
        index: usize,
        frame: *const f64,
        sink: extern "C" fn(*mut c_void, i32, *const f64, usize),
        context: *mut c_void,
        error: *mut c_char,
        error_size: usize,
    ) -> i32;
}
pub(crate) fn project(
    shape: &Shape,
    kind: i32,
    index: usize,
    frame: crate::protocol::PlaneFrame,
) -> Result<Vec<(i32, Vec<f64>)>> {
    extern "C" fn receive(context: *mut c_void, kind: i32, data: *const f64, count: usize) {
        let output = unsafe { &mut *context.cast::<Vec<(i32, Vec<f64>)>>() };
        output.push((
            kind,
            unsafe { std::slice::from_raw_parts(data, count) }.to_vec(),
        ));
    }
    let frame = [frame.origin, frame.u, frame.v, frame.normal].concat();
    let mut output: Vec<(i32, Vec<f64>)> = vec![];
    let mut error = [0; 1024];
    let status = unsafe {
        pamat_sketch_project(
            shape.raw.as_ptr(),
            kind,
            index,
            frame.as_ptr(),
            receive,
            (&mut output as *mut Vec<(i32, Vec<f64>)>).cast(),
            error.as_mut_ptr(),
            error.len(),
        )
    };
    if status != 0 {
        return Err(CoreError::new(
            ErrorCode::KernelFailure,
            unsafe { CStr::from_ptr(error.as_ptr()) }
                .to_string_lossy()
                .into_owned(),
        ));
    }
    Ok(output)
}

fn encode(sketch: &Sketch, selected: Option<&str>) -> Result<(Vec<Curve>, Vec<f64>, Vec<String>)> {
    let mut curves = vec![];
    let mut data = vec![];
    let mut ids = vec![];
    let bounds = selected.map_or((Unbounded, Unbounded), |id| (Included(id), Included(id)));
    for (id, e) in sketch.entities.range::<str, _>(bounds) {
        if selected.is_none() && e.construction {
            continue;
        }
        let start = data.len();
        let kind = match &e.geometry {
            SketchGeometry::Point { .. } => continue,
            SketchGeometry::Line { from, to } => {
                data.extend(sketch.point_position(from)?);
                data.extend(sketch.point_position(to)?);
                0
            }
            SketchGeometry::Circle { center, radius } => {
                data.extend(sketch.point_position(center)?);
                data.push(*radius);
                1
            }
            SketchGeometry::Arc {
                center,
                radius,
                start,
                end,
                ..
            } => {
                data.extend(sketch.point_position(center)?);
                data.extend([*radius, *start, *end]);
                2
            }
            SketchGeometry::Ellipse {
                center,
                major,
                minor,
                angle,
            } => {
                data.extend(sketch.point_position(center)?);
                data.extend([*major, *minor, *angle]);
                3
            }
            SketchGeometry::Spline {
                points,
                degree,
                knots,
                closed,
                fit,
                weights,
            } => {
                if let Some(spline) = sketch.splines.get(id).filter(|s| !s.fit_points.is_empty()) {
                    let nodes = &spline.fit_points;
                    let spans =
                        if *closed && nodes.first().unwrap().point != nodes.last().unwrap().point {
                            nodes.len()
                        } else {
                            nodes.len() - 1
                        };
                    let n = 3 * spans + 1;
                    data.extend([3., n as f64, f64::from(*closed), 0.]);
                    data.extend(sketch.point_position(&nodes[0].point.id)?);
                    for i in 0..spans {
                        let next = &nodes[(i + 1) % nodes.len()];
                        for r in [
                            nodes[i].outgoing.as_ref().unwrap(),
                            next.incoming.as_ref().unwrap(),
                            &next.point,
                        ] {
                            data.extend(sketch.point_position(&r.id)?);
                        }
                    }
                    data.extend([0.; 4]);
                    for i in 1..spans {
                        data.extend([i as f64 / spans as f64; 3]);
                    }
                    data.extend([1.; 4]);
                    data.extend(vec![1.; n]);
                } else {
                    data.extend([
                        *degree as f64,
                        points.len() as f64,
                        f64::from(*closed),
                        f64::from(*fit),
                    ]);
                    for p in points {
                        data.extend(sketch.point_position(p)?);
                    }
                    data.extend(knots);
                    data.extend(weights);
                }
                4
            }
        };
        curves.push(Curve {
            kind,
            start,
            count: data.len() - start,
        });
        ids.push(id.clone());
    }
    Ok((curves, data, ids))
}

// Exact, collision-free input key. Referenced point coordinates, curve parameters,
// construction inclusion, source identities and the support frame all participate.
pub(crate) fn geometry_key(sketch: &Sketch, selected: Option<&[String]>) -> Result<Vec<u8>> {
    let (curves, data, ids) = encode_curves(sketch, selected)?;
    let mut key = vec![];
    key.extend((curves.len() as u64).to_le_bytes());
    for id in [&sketch.data.scene_id, &sketch.data.id]
        .into_iter()
        .chain(ids.iter())
    {
        key.extend((id.len() as u64).to_le_bytes());
        key.extend(id.as_bytes());
    }
    for curve in curves {
        key.extend(curve.kind.to_le_bytes());
        key.extend((curve.count as u64).to_le_bytes());
    }
    for value in [
        sketch.frame.origin,
        sketch.frame.u,
        sketch.frame.v,
        sketch.frame.normal,
    ]
    .into_iter()
    .flatten()
    .chain(data)
    {
        key.extend(value.to_bits().to_le_bytes());
    }
    Ok(key)
}
extern "C" {
    fn pamat_sketch_curve_proxy(
        frame: *const f64,
        curve: *const Curve,
        data: *const f64,
        sink: extern "C" fn(*mut c_void, *const f64, usize),
        context: *mut c_void,
        error: *mut c_char,
        error_size: usize,
    ) -> i32;
}
pub(crate) fn curve_samples(sketch: &Sketch, id: &str) -> Result<Vec<[f64; 3]>> {
    let (curves, data, _) = encode(sketch, Some(id))?;
    if curves.len() != 1 {
        return Err(CoreError::new(
            ErrorCode::InvalidParameter,
            "Select a sketch curve",
        ));
    }
    extern "C" fn receive(context: *mut c_void, points: *const f64, count: usize) {
        let output = unsafe { &mut *context.cast::<Vec<[f64; 3]>>() };
        let points = unsafe { std::slice::from_raw_parts(points, count * 3) };
        output.extend(points.chunks_exact(3).map(|p| [p[0], p[1], p[2]]));
    }
    let frame = [
        sketch.frame.origin,
        sketch.frame.u,
        sketch.frame.v,
        sketch.frame.normal,
    ]
    .concat();
    let mut output: Vec<[f64; 3]> = vec![];
    let mut error = [0; 1024];
    let status = unsafe {
        pamat_sketch_curve_proxy(
            frame.as_ptr(),
            curves.as_ptr(),
            data.as_ptr(),
            receive,
            (&mut output as *mut Vec<[f64; 3]>).cast(),
            error.as_mut_ptr(),
            error.len(),
        )
    };
    if status != 0 {
        return Err(CoreError::new(
            ErrorCode::KernelFailure,
            unsafe { CStr::from_ptr(error.as_ptr()) }
                .to_string_lossy()
                .into_owned(),
        ));
    }
    Ok(output)
}
extern "C" {
    fn pamat_sketch_modify(
        frame: *const f64,
        curves: *const Curve,
        count: usize,
        data: *const f64,
        operation: i32,
        value: f64,
        position: *const f64,
        sink: extern "C" fn(*mut c_void, usize, i32, *const f64, usize),
        context: *mut c_void,
        error: *mut c_char,
        error_size: usize,
    ) -> i32;
}
pub(crate) fn modify(
    sketch: &Sketch,
    ids: &[String],
    operation: i32,
    value: f64,
    position: Option<[f64; 2]>,
) -> Result<Vec<(Option<String>, i32, Vec<f64>)>> {
    let (curves, data, _) = encode_curves(sketch, Some(ids))?;
    Ok(
        modify_encoded(sketch.frame, &curves, &data, operation, value, position)?
            .into_iter()
            .map(|(source, kind, data)| (ids.get(source).cloned(), kind, data))
            .collect(),
    )
}

// Font outlines are lines and quadratic/cubic Beziers. Normalize before creating
// sketch entities so cache state cannot affect entity allocation.
pub(crate) fn normalize_text(outlines: &[Vec<[f64; 2]>]) -> Result<Vec<(i32, Vec<f64>)>> {
    let mut curves = Vec::with_capacity(outlines.len());
    let mut data = vec![];
    for segment in outlines {
        let n = segment.len();
        if !(2..=4).contains(&n) || segment.iter().flatten().any(|x| !x.is_finite()) {
            return Err(CoreError::new(
                ErrorCode::InvalidParameter,
                "Invalid glyph outline",
            ));
        }
        let start = data.len();
        if n > 2 {
            data.extend([(n - 1) as f64, n as f64, 0., 0.]);
        }
        data.extend(segment.iter().flatten().copied());
        if n > 2 {
            data.extend(std::iter::repeat(0.).take(n));
            data.extend(std::iter::repeat(1.).take(2 * n)); // end knots, then weights
        }
        curves.push(Curve {
            kind: if n == 2 { 0 } else { 4 },
            start,
            count: data.len() - start,
        });
    }
    if curves.is_empty() {
        return Ok(vec![]);
    }
    Ok(modify_encoded(
        crate::sketch::Frame::builtin(crate::protocol::Plane::Xy),
        &curves,
        &data,
        3,
        0.,
        None,
    )?
    .into_iter()
    .map(|(_, kind, data)| (kind, data))
    .collect())
}

fn modify_encoded(
    frame: crate::sketch::Frame,
    curves: &[Curve],
    data: &[f64],
    operation: i32,
    value: f64,
    position: Option<[f64; 2]>,
) -> Result<Vec<(usize, i32, Vec<f64>)>> {
    extern "C" fn receive(
        context: *mut c_void,
        source: usize,
        kind: i32,
        data: *const f64,
        count: usize,
    ) {
        let output = unsafe { &mut *context.cast::<Vec<(usize, i32, Vec<f64>)>>() };
        output.push((
            source,
            kind,
            unsafe { std::slice::from_raw_parts(data, count) }.to_vec(),
        ));
    }
    let frame = [frame.origin, frame.u, frame.v, frame.normal].concat();
    let mut output: Vec<(usize, i32, Vec<f64>)> = vec![];
    let mut error = [0; 1024];
    let status = unsafe {
        pamat_sketch_modify(
            frame.as_ptr(),
            curves.as_ptr(),
            curves.len(),
            data.as_ptr(),
            operation,
            value,
            position.as_ref().map_or(std::ptr::null(), |p| p.as_ptr()),
            receive,
            (&mut output as *mut Vec<(usize, i32, Vec<f64>)>).cast(),
            error.as_mut_ptr(),
            error.len(),
        )
    };
    if status != 0 {
        return Err(CoreError::new(
            ErrorCode::InvalidParameter,
            unsafe { CStr::from_ptr(error.as_ptr()) }
                .to_string_lossy()
                .into_owned(),
        ));
    }
    Ok(output)
}

fn encode_curves(
    sketch: &Sketch,
    selected: Option<&[String]>,
) -> Result<(Vec<Curve>, Vec<f64>, Vec<String>)> {
    let Some(ids) = selected else {
        return encode(sketch, None);
    };
    let mut curves = vec![];
    let mut data = vec![];
    for id in ids {
        let (mut item, values, _) = encode(sketch, Some(id))?;
        if item.len() != 1 {
            return Err(CoreError::new(
                ErrorCode::InvalidParameter,
                "Select curves to edit",
            ));
        }
        item[0].start = data.len();
        data.extend(values);
        curves.extend(item);
    }
    Ok((curves, data, ids.to_vec()))
}
