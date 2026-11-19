use pamatcad_core::{
    error::{CoreError, ErrorCode},
    Engine,
};
use std::{
    cell::RefCell,
    ffi::{c_char, CStr, CString},
};

thread_local! { static ENGINE: RefCell<Engine> = RefCell::new(Engine::default()); }

/// Dispatch one SDK request to the engine owned by this worker.
///
/// # Safety
/// `input` must point to a valid NUL-terminated JSON string for the duration of this call.
/// The caller owns the returned string and must release it with `pamatcad_release`.
#[no_mangle]
pub unsafe extern "C" fn pamatcad_execute(input: *const c_char) -> *mut c_char {
    let result = serde_json::from_slice(CStr::from_ptr(input).to_bytes())
        .map_err(|e| CoreError::new(ErrorCode::InvalidParameter, e.to_string()))
        .and_then(|request| ENGINE.with(|engine| engine.borrow_mut().execute(request)));
    CString::new(serde_json::to_vec(&result).unwrap())
        .unwrap()
        .into_raw()
}

/// # Safety
/// `result` must be a live pointer returned by `pamatcad_execute` and released exactly once.
#[no_mangle]
pub unsafe extern "C" fn pamatcad_release(result: *mut c_char) {
    drop(CString::from_raw(result));
}
