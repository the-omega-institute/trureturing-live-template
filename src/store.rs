use crate::{Error, Result, model::*, project, reduce, require};
use serde::{Serialize, de::DeserializeOwned};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

pub fn read_json<T: DeserializeOwned>(path: &Path) -> Result<T> {
    let file = File::open(path)?;
    let mut bytes = Vec::new();
    file.take(64 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
    require(bytes.len() <= 64 * 1024 * 1024, "input exceeds byte bound")?;
    Ok(serde_json::from_slice(&bytes)?)
}

pub fn atomic_json(path: &Path, value: &impl Serialize) -> Result<()> {
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    fs::create_dir_all(parent)?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| Error::Contract("invalid system clock".into()))?
        .as_nanos();
    let temporary = parent.join(format!(".live-{}-{nonce}.tmp", std::process::id()));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        serde_json::to_writer(&mut file, value)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        fs::rename(&temporary, path)?;
        File::open(parent)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

/// The checkpoint is authoritative. A crash between the two renames is repaired
/// by `project`; the browser never observes a partially written JSON document.
pub fn transaction<F>(
    config: &Config,
    state_path: &Path,
    output: &Path,
    make_input: F,
) -> Result<View>
where
    F: FnOnce(Option<&Checkpoint>) -> Result<Ingest>,
{
    require(
        state_path != output,
        "checkpoint and public view must use distinct paths",
    )?;
    if let Some(parent) = state_path.parent().filter(|p| !p.as_os_str().is_empty()) {
        fs::create_dir_all(parent)?;
    }
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let lock = options.open(state_path.with_extension("lock"))?;
    lock.lock()?;
    let previous: Option<Checkpoint> = match read_json(state_path) {
        Ok(s) => Some(s),
        Err(Error::Io(e)) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e),
    };
    let input = make_input(previous.as_ref())?;
    let next = reduce(config, previous.as_ref(), &input)?;
    let view = project(config, &next)?;
    atomic_json(state_path, &next)?;
    atomic_json(output, &view)?;
    Ok(view)
}
