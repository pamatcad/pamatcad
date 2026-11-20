#[derive(serde::Serialize)]
pub struct Footprint {
    bytes: u64,
    processes: usize,
}

#[cfg(not(target_os = "macos"))]
pub fn footprint() -> Option<Footprint> {
    None
}

#[cfg(target_os = "macos")]
pub use macos::footprint;

#[cfg(target_os = "macos")]
mod macos {
    use super::Footprint;
    use std::{mem::size_of, ptr};

    // Apple-private ABI: xnu/bsd/sys/proc_info_private.h. Keep this isolated;
    // unsupported queries must return unavailable, never a backend-only total.
    const PROC_PIDCOALITIONINFO: libc::c_int = 20;
    #[repr(C)]
    #[derive(Default)]
    struct CoalitionInfo {
        ids: [u64; 2],
        reserved: [u64; 3],
    }

    fn coalition(pid: libc::pid_t) -> Option<u64> {
        let mut info = CoalitionInfo::default();
        // SAFETY: info is a writable, correctly sized proc_pidcoalitioninfo buffer.
        let read = unsafe {
            libc::proc_pidinfo(
                pid,
                PROC_PIDCOALITIONINFO,
                0,
                ptr::from_mut(&mut info).cast(),
                size_of::<CoalitionInfo>() as libc::c_int,
            )
        };
        // The jetsam coalition includes WebKit's launchd-owned XPC helpers.
        (read as usize == size_of::<CoalitionInfo>() && info.ids[1] != 0).then_some(info.ids[1])
    }

    pub fn footprint() -> Option<Footprint> {
        // SAFETY: these libproc calls use owned, initialized buffers of the stated
        // sizes; rusage_info_v4 contains only integer/byte fields. No pointers escape.
        unsafe {
            let own_pid = libc::getpid();
            let group = coalition(own_pid)?;
            // Direct cargo/terminal launches can inherit another application's
            // coalition. Only report an independently attributed app group.
            if coalition(libc::getppid()) == Some(group) {
                return None;
            }

            let count = libc::proc_listallpids(ptr::null_mut(), 0);
            if count <= 0 {
                return None;
            }
            let mut pids = vec![0 as libc::pid_t; count as usize + 256];
            let count = libc::proc_listallpids(
                pids.as_mut_ptr().cast(),
                (pids.len() * size_of::<libc::pid_t>()) as libc::c_int,
            );
            if count <= 0 || count as usize >= pids.len() {
                return None;
            }
            pids.truncate(count as usize);
            pids.sort_unstable();
            pids.dedup();

            let mut total = Footprint {
                bytes: 0,
                processes: 0,
            };
            let mut found_self = false;
            for pid in pids {
                if pid <= 0 || coalition(pid) != Some(group) {
                    continue;
                }
                // Reject a group shared with another app, even if its parent has
                // exited. System XPC helper paths do not match this bundle path.
                let mut path = [0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
                if libc::proc_pidpath(pid, path.as_mut_ptr().cast(), path.len() as u32) <= 0 {
                    return None;
                }
                if pid != own_pid && String::from_utf8_lossy(&path).contains(".app/Contents/MacOS/")
                {
                    return None;
                }

                let mut usage: libc::rusage_info_v4 = std::mem::zeroed();
                let result = libc::proc_pid_rusage(
                    pid,
                    libc::RUSAGE_INFO_V4,
                    ptr::from_mut(&mut usage).cast(),
                );
                // A helper may exit while sampling. Do not count a reused PID or
                // publish a partial total when a live group member cannot be read.
                if coalition(pid) != Some(group) {
                    continue;
                }
                if result != 0 {
                    return None;
                }
                total.bytes = total.bytes.checked_add(usage.ri_phys_footprint)?;
                total.processes += 1;
                found_self |= pid == own_pid;
            }
            found_self.then_some(total)
        }
    }
}
