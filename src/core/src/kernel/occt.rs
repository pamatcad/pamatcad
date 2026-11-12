use crate::error::{CoreError, ErrorCode, Result};
use crate::sketch::Frame;
use std::{
    ffi::{c_char, c_void, CStr},
    ptr::NonNull,
};

extern "C" {
    fn pamat_extrude(
        points: *const f64,
        count: usize,
        direction: *const f64,
        output: *mut *mut c_void,
        error: *mut c_char,
        error_size: usize,
    ) -> i32;
    fn pamat_extrude_circle(
        center: *const f64,
        radius: f64,
        normal: *const f64,
        direction: *const f64,
        output: *mut *mut c_void,
        error: *mut c_char,
        error_size: usize,
    ) -> i32;
    fn pamat_cut(
        body: *const c_void,
        tool: *const c_void,
        output: *mut *mut c_void,
        error: *mut c_char,
        error_size: usize,
    ) -> i32;
    fn pamat_face_count(shape: *const c_void, face_id: usize) -> usize;
    fn pamat_face_by_normal(
        shape: *mut c_void,
        normal: *const f64,
        count: *mut usize,
        face_id: *mut usize,
        error: *mut c_char,
        error_size: usize,
    ) -> i32;
    fn pamat_face_frame(
        shape: *const c_void,
        face_id: usize,
        frame: *mut f64,
        error: *mut c_char,
        error_size: usize,
    ) -> i32;
    fn pamat_write_step(
        shapes: *const *const c_void,
        count: usize,
        sink: extern "C" fn(*mut c_void, *const u8, usize),
        context: *mut c_void,
        error: *mut c_char,
        error_size: usize,
    ) -> i32;
    fn pamat_mesh(
        shape: *const c_void,
        sink: extern "C" fn(*mut c_void, *const f64),
        context: *mut c_void,
        error: *mut c_char,
        error_size: usize,
    ) -> i32;
    fn pamat_volume(
        shape: *const c_void,
        output: *mut f64,
        error: *mut c_char,
        error_size: usize,
    ) -> i32;
    fn pamat_shape_free(shape: *mut c_void);
}

// A shape stays on its engine's thread and has exactly one Rust owner.
pub struct Shape(NonNull<c_void>);

fn failure(error: &[c_char]) -> CoreError {
    let message = unsafe { CStr::from_ptr(error.as_ptr()) }
        .to_string_lossy()
        .into_owned();
    CoreError::new(ErrorCode::KernelFailure, message)
}

impl Shape {
    pub fn extrude(points: &[[f64; 3]], direction: [f64; 3]) -> Result<Self> {
        let mut output = std::ptr::null_mut();
        let mut error = [0; 1024];
        let status = unsafe {
            pamat_extrude(
                points.as_ptr().cast(),
                points.len(),
                direction.as_ptr(),
                &mut output,
                error.as_mut_ptr(),
                error.len(),
            )
        };
        if status != 0 {
            return Err(failure(&error));
        }
        NonNull::new(output).map(Self).ok_or_else(|| {
            CoreError::new(
                ErrorCode::KernelFailure,
                "OCCT returned an empty shape handle",
            )
        })
    }

    pub fn extrude_circle(
        center: [f64; 3],
        radius: f64,
        normal: [f64; 3],
        direction: [f64; 3],
    ) -> Result<Self> {
        let mut output = std::ptr::null_mut();
        let mut error = [0; 1024];
        let status = unsafe {
            pamat_extrude_circle(
                center.as_ptr(),
                radius,
                normal.as_ptr(),
                direction.as_ptr(),
                &mut output,
                error.as_mut_ptr(),
                error.len(),
            )
        };
        if status != 0 {
            return Err(failure(&error));
        }
        NonNull::new(output).map(Self).ok_or_else(|| {
            CoreError::new(
                ErrorCode::KernelFailure,
                "OCCT returned an empty shape handle",
            )
        })
    }

    pub fn cut(&self, tool: &Shape) -> Result<Option<Self>> {
        let mut output = std::ptr::null_mut();
        let mut error = [0; 1024];
        let status = unsafe {
            pamat_cut(
                self.0.as_ptr(),
                tool.0.as_ptr(),
                &mut output,
                error.as_mut_ptr(),
                error.len(),
            )
        };
        if status != 0 {
            return Err(failure(&error));
        }
        Ok(NonNull::new(output).map(Self))
    }

    pub fn face_by_normal(&self, direction: [f64; 3]) -> Result<usize> {
        let norm = direction[0].hypot(direction[1]).hypot(direction[2]);
        if !norm.is_finite() || norm == 0. {
            return Err(CoreError::new(
                ErrorCode::InvalidParameter,
                "Face normal must be finite and nonzero",
            ));
        }
        let normal = direction.map(|x| x / norm);
        let mut count = 0;
        let mut id = 0;
        let mut error = [0; 1024];
        let status = unsafe {
            pamat_face_by_normal(
                self.0.as_ptr(),
                normal.as_ptr(),
                &mut count,
                &mut id,
                error.as_mut_ptr(),
                error.len(),
            )
        };
        if status != 0 {
            return Err(failure(&error));
        }
        Self::require_one_face(count)?;
        Ok(id)
    }

    fn require_one_face(count: usize) -> Result<()> {
        match count {
            1 => Ok(()),
            0 => Err(CoreError::new(ErrorCode::NotFound, "No matching face")),
            _ => Err(CoreError::new(
                ErrorCode::AmbiguousFace,
                "Multiple matching faces",
            )),
        }
    }

    pub fn face_frame(&self, id: usize) -> Result<Frame> {
        Self::require_one_face(unsafe { pamat_face_count(self.0.as_ptr(), id) })?;
        let mut coords = [[0.; 3]; 4];
        let mut error = [0; 1024];
        let status = unsafe {
            pamat_face_frame(
                self.0.as_ptr(),
                id,
                coords.as_mut_ptr().cast(),
                error.as_mut_ptr(),
                error.len(),
            )
        };
        if status != 0 {
            return Err(failure(&error));
        }
        let [origin, u, v, normal] = coords;
        Ok(Frame {
            origin,
            u,
            v,
            normal,
        })
    }

    pub fn write_step(shapes: &[&Shape]) -> Result<Vec<u8>> {
        extern "C" fn append(context: *mut c_void, data: *const u8, len: usize) {
            // Both pointers are valid for this synchronous call; the writer owns the byte slice.
            unsafe {
                (*context.cast::<Vec<u8>>())
                    .extend_from_slice(std::slice::from_raw_parts(data, len))
            }
        }
        let handles: Vec<_> = shapes.iter().map(|s| s.0.as_ptr().cast_const()).collect();
        let mut bytes = Vec::new();
        let mut error = [0; 1024];
        let status = unsafe {
            pamat_write_step(
                handles.as_ptr(),
                handles.len(),
                append,
                (&mut bytes as *mut Vec<u8>).cast(),
                error.as_mut_ptr(),
                error.len(),
            )
        };
        if status != 0 {
            return Err(failure(&error));
        }
        Ok(bytes)
    }

    pub fn mesh(&self, triangles: &mut Vec<[[f64; 3]; 3]>) -> Result<()> {
        extern "C" fn append(context: *mut c_void, xyz: *const f64) {
            // The mesher supplies nine consecutive world-space coordinates per triangle.
            unsafe { (*context.cast::<Vec<[[f64; 3]; 3]>>()).push(*xyz.cast::<[[f64; 3]; 3]>()) }
        }
        let mut error = [0; 1024];
        let status = unsafe {
            pamat_mesh(
                self.0.as_ptr(),
                append,
                (triangles as *mut Vec<[[f64; 3]; 3]>).cast(),
                error.as_mut_ptr(),
                error.len(),
            )
        };
        if status != 0 {
            return Err(failure(&error));
        }
        Ok(())
    }

    pub fn volume(&self) -> Result<f64> {
        let mut output = 0.0;
        let mut error = [0; 1024];
        let status = unsafe {
            pamat_volume(
                self.0.as_ptr(),
                &mut output,
                error.as_mut_ptr(),
                error.len(),
            )
        };
        if status != 0 {
            return Err(failure(&error));
        }
        Ok(output)
    }
}

impl Drop for Shape {
    fn drop(&mut self) {
        unsafe { pamat_shape_free(self.0.as_ptr()) }
    }
}
