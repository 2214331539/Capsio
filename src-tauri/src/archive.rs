//! Just enough ZIP for manuscripts: reading what Overleaf, macOS, Windows and arXiv tools
//! write (stored or deflated entries) and writing source packages. No ZIP64 or encryption.
use flate2::{read::DeflateDecoder, write::DeflateEncoder, Compression, Crc};
use std::io::{Read, Write};

const LOCAL: u32 = 0x0403_4b50;
const CENTRAL: u32 = 0x0201_4b50;
const END: u32 = 0x0605_4b50;
const UTF8: u16 = 1 << 11;

/// One file in an archive; directories and symbolic links are left out.
#[derive(Debug)]
pub struct Item {
    pub name: String,
    pub size: u64,
    method: u16,
    crc: u32,
    compressed: u64,
    offset: u64,
}

fn corrupt() -> String {
    "压缩包已损坏。".into()
}
fn u16_at(bytes: &[u8], at: usize) -> Result<u16, String> {
    let b = bytes.get(at..at + 2).ok_or_else(corrupt)?;
    Ok(u16::from_le_bytes([b[0], b[1]]))
}
fn u32_at(bytes: &[u8], at: usize) -> Result<u32, String> {
    let b = bytes.get(at..at + 4).ok_or_else(corrupt)?;
    Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
}

/// Code page 437, which ZIP uses for names without the UTF-8 flag.
const CP437: [&str; 8] = [
    "ÇüéâäàåçêëèïîìÄÅ",
    "ÉæÆôöòûùÿÖÜ¢£¥₧ƒ",
    "áíóúñÑªº¿⌐¬½¼¡«»",
    "░▒▓│┤╡╢╖╕╣║╗╝╜╛┐",
    "└┴┬├─┼╞╟╚╔╩╦╠═╬╧",
    "╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀",
    "αßΓπΣσµτΦΘΩδ∞φε∩",
    "≡±≥≤⌠⌡÷≈°∙·√ⁿ²■",
];

fn name(raw: &[u8], utf8: bool) -> String {
    // Many tools write UTF-8 without setting the flag, so valid UTF-8 is taken as such.
    match std::str::from_utf8(raw) {
        Ok(text) => text.to_owned(),
        Err(_) if utf8 => String::from_utf8_lossy(raw).into_owned(),
        Err(_) => raw
            .iter()
            .map(|&b| match b {
                0..=0x7f => b as char,
                0xff => char::from_u32(0xa0).unwrap_or(' '),
                _ => {
                    let at = usize::from(b - 0x80);
                    CP437[at / 16].chars().nth(at % 16).unwrap_or('_')
                }
            })
            .collect(),
    }
}

/// Lists the files in a ZIP from its central directory.
pub fn list(bytes: &[u8], max_entries: usize) -> Result<Vec<Item>, String> {
    let lowest = bytes.len().saturating_sub(22 + 0xffff);
    let end = (lowest..=bytes.len().saturating_sub(22))
        .rev()
        .find(|&at| u32_at(bytes, at) == Ok(END))
        .ok_or("不是有效的 zip 文件。")?;
    let count = u16_at(bytes, end + 10)?;
    let start = u32_at(bytes, end + 16)?;
    if count == 0xffff || start == 0xffff_ffff {
        return Err("不支持 ZIP64 格式的压缩包。".into());
    }
    if usize::from(count) > max_entries {
        return Err("压缩包里的文件太多。".into());
    }
    let mut at = start as usize;
    let mut items = Vec::new();
    for _ in 0..count {
        if u32_at(bytes, at)? != CENTRAL {
            return Err(corrupt());
        }
        let flags = u16_at(bytes, at + 8)?;
        let method = u16_at(bytes, at + 10)?;
        let crc = u32_at(bytes, at + 16)?;
        let compressed = u32_at(bytes, at + 20)?;
        let size = u32_at(bytes, at + 24)?;
        let name_length = usize::from(u16_at(bytes, at + 28)?);
        let extra = usize::from(u16_at(bytes, at + 30)?);
        let comment = usize::from(u16_at(bytes, at + 32)?);
        let attributes = u32_at(bytes, at + 38)?;
        let offset = u32_at(bytes, at + 42)?;
        let raw = bytes
            .get(at + 46..at + 46 + name_length)
            .ok_or_else(corrupt)?;
        at += 46 + name_length + extra + comment;
        let name = name(raw, flags & UTF8 != 0).replace('\\', "/");
        let link = (attributes >> 16) & 0o170_000 == 0o120_000;
        if name.ends_with('/') || link {
            continue;
        }
        if flags & 1 != 0 {
            return Err("不支持加密的压缩包。".into());
        }
        if [compressed, size, offset].contains(&0xffff_ffff) {
            return Err("不支持 ZIP64 格式的压缩包。".into());
        }
        items.push(Item {
            name,
            size: size.into(),
            method,
            crc,
            compressed: compressed.into(),
            offset: offset.into(),
        });
    }
    Ok(items)
}

/// The contents of one listed file, checked against its CRC.
pub fn extract(bytes: &[u8], item: &Item) -> Result<Vec<u8>, String> {
    let at = item.offset as usize;
    if u32_at(bytes, at)? != LOCAL {
        return Err(corrupt());
    }
    let start =
        at + 30 + usize::from(u16_at(bytes, at + 26)?) + usize::from(u16_at(bytes, at + 28)?);
    let data = bytes
        .get(start..start + item.compressed as usize)
        .ok_or_else(corrupt)?;
    let content = match item.method {
        0 => data.to_vec(),
        8 => {
            let mut out = Vec::with_capacity(item.size as usize);
            DeflateDecoder::new(data)
                .take(item.size + 1)
                .read_to_end(&mut out)
                .map_err(|_| corrupt())?;
            out
        }
        _ => return Err(format!("{} 使用了不支持的压缩方式。", item.name)),
    };
    let mut crc = Crc::new();
    crc.update(&content);
    if content.len() as u64 != item.size || crc.sum() != item.crc {
        return Err(format!("压缩包里的 {} 已损坏。", item.name));
    }
    Ok(content)
}

fn put16(out: &mut Vec<u8>, value: u16) {
    out.extend_from_slice(&value.to_le_bytes());
}
fn put32(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_le_bytes());
}

/// Writes a ZIP with UTF-8 names, deflating each file unless that makes it larger.
pub struct Writer<W: Write> {
    out: W,
    offset: u64,
    central: Vec<u8>,
    count: usize,
    time: u16,
    date: u16,
}

impl<W: Write> Writer<W> {
    pub fn new(out: W) -> Self {
        use chrono::{Datelike, Timelike};
        let now = chrono::Local::now();
        Self {
            out,
            offset: 0,
            central: Vec::new(),
            count: 0,
            time: ((now.hour() << 11) | (now.minute() << 5) | (now.second() / 2)) as u16,
            date: (((now.year().clamp(1980, 2107) - 1980) as u32) << 9
                | now.month() << 5
                | now.day()) as u16,
        }
    }

    pub fn add(&mut self, name: &str, data: &[u8]) -> Result<(), String> {
        let too_big = || "源码包超过 4 GB，或者文件太多。".to_string();
        if data.len() as u64 >= 0xffff_ffff || self.offset >= 0xffff_ffff || self.count >= 0xfffe {
            return Err(too_big());
        }
        let mut crc = Crc::new();
        crc.update(data);
        let mut encoder = DeflateEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(data).map_err(|e| e.to_string())?;
        let packed = encoder.finish().map_err(|e| e.to_string())?;
        let (method, body): (u16, &[u8]) = if packed.len() < data.len() {
            (8, &packed)
        } else {
            (0, data)
        };
        let name = name.as_bytes();
        let mut fields = Vec::with_capacity(26);
        put16(&mut fields, 20);
        put16(&mut fields, UTF8);
        put16(&mut fields, method);
        put16(&mut fields, self.time);
        put16(&mut fields, self.date);
        put32(&mut fields, crc.sum());
        put32(&mut fields, body.len() as u32);
        put32(&mut fields, data.len() as u32);
        put16(&mut fields, name.len() as u16);
        put16(&mut fields, 0);
        let mut local = Vec::with_capacity(30 + name.len());
        put32(&mut local, LOCAL);
        local.extend_from_slice(&fields);
        local.extend_from_slice(name);
        self.out.write_all(&local).map_err(|e| e.to_string())?;
        self.out.write_all(body).map_err(|e| e.to_string())?;
        put32(&mut self.central, CENTRAL);
        put16(&mut self.central, 20);
        self.central.extend_from_slice(&fields);
        put16(&mut self.central, 0);
        put16(&mut self.central, 0);
        put16(&mut self.central, 0);
        put32(&mut self.central, 0);
        put32(&mut self.central, self.offset as u32);
        self.central.extend_from_slice(name);
        self.offset += (local.len() + body.len()) as u64;
        self.count += 1;
        if self.offset >= 0xffff_ffff {
            return Err(too_big());
        }
        Ok(())
    }

    pub fn finish(mut self) -> Result<W, String> {
        let mut end = Vec::with_capacity(22);
        put32(&mut end, END);
        put16(&mut end, 0);
        put16(&mut end, 0);
        put16(&mut end, self.count as u16);
        put16(&mut end, self.count as u16);
        put32(&mut end, self.central.len() as u32);
        put32(&mut end, self.offset as u32);
        put16(&mut end, 0);
        self.out
            .write_all(&self.central)
            .and_then(|_| self.out.write_all(&end))
            .and_then(|_| self.out.flush())
            .map_err(|e| e.to_string())?;
        Ok(self.out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn written_archives_read_back() {
        let text = "\\documentclass{article}\n".repeat(200);
        let mut writer = Writer::new(Vec::new());
        writer.add("main.tex", text.as_bytes()).unwrap();
        writer.add("图/plot.png", &[0, 1, 2, 3]).unwrap();
        writer.add("empty.bib", b"").unwrap();
        let bytes = writer.finish().unwrap();
        let items = list(&bytes, 10).unwrap();
        let names: Vec<&str> = items.iter().map(|item| item.name.as_str()).collect();
        assert_eq!(names, ["main.tex", "图/plot.png", "empty.bib"]);
        assert_eq!(items[0].method, 8, "text is deflated");
        assert_eq!(items[1].method, 0, "tiny files are stored");
        assert_eq!(extract(&bytes, &items[0]).unwrap(), text.as_bytes());
        assert_eq!(extract(&bytes, &items[1]).unwrap(), [0, 1, 2, 3]);
        assert!(extract(&bytes, &items[2]).unwrap().is_empty());
        assert!(list(&bytes, 2).is_err(), "too many entries");
    }

    #[test]
    fn reads_archives_from_other_tools_and_rejects_damage() {
        // Made by Windows' bsdtar (`tar -a -cf`), with a folder entry and extra fields.
        let bytes = base64_decode(FIXTURE);
        let items = list(&bytes, 10).unwrap();
        let names: Vec<&str> = items.iter().map(|item| item.name.as_str()).collect();
        assert_eq!(names, ["paper/main.tex", "paper/refs.bib"]);
        let main = String::from_utf8(extract(&bytes, &items[0]).unwrap()).unwrap();
        assert!(main.starts_with("\\documentclass{article}"));
        assert_eq!(extract(&bytes, &items[1]).unwrap(), b"@misc{a,title={A}}\n");
        let mut damaged = bytes.clone();
        let local = items[0].offset as usize;
        let data = local
            + 30
            + usize::from(u16_at(&bytes, local + 26).unwrap())
            + usize::from(u16_at(&bytes, local + 28).unwrap());
        damaged[data + 4] ^= 0xff;
        assert!(extract(&damaged, &items[0]).is_err());
        assert!(list(b"not a zip at all, just some bytes", 10).is_err());
    }

    /// The system bsdtar on Windows and macOS reads zip files; GNU tar elsewhere does not.
    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn other_tools_unpack_written_archives() {
        let temp = tempfile::tempdir().unwrap();
        let mut writer = Writer::new(Vec::new());
        writer
            .add(
                "paper/main.tex",
                "\\documentclass{article}\n".repeat(50).as_bytes(),
            )
            .unwrap();
        writer.add("paper/图.png", &[1, 2, 3]).unwrap();
        std::fs::write(temp.path().join("out.zip"), writer.finish().unwrap()).unwrap();
        let tar = if cfg!(windows) {
            std::path::PathBuf::from(std::env::var_os("SystemRoot").unwrap())
                .join(r"System32\tar.exe")
        } else {
            std::path::PathBuf::from("/usr/bin/tar")
        };
        let status = std::process::Command::new(tar)
            .current_dir(temp.path())
            .args(["-xf", "out.zip"])
            .status()
            .unwrap();
        assert!(status.success());
        let main = std::fs::read_to_string(temp.path().join("paper/main.tex")).unwrap();
        assert_eq!(main, "\\documentclass{article}\n".repeat(50));
        assert_eq!(
            std::fs::read(temp.path().join("paper/图.png")).unwrap(),
            [1, 2, 3]
        );
    }

    #[test]
    fn names_without_the_utf8_flag_fall_back_to_cp437() {
        // 0x80–0xFE; 0xFF is the no-break space.
        assert_eq!(
            CP437.iter().map(|row| row.chars().count()).sum::<usize>(),
            127
        );
        assert_eq!(name(b"main.tex", false), "main.tex");
        assert_eq!(name(&[0x80, b'.', b't', b'e', b'x'], false), "Ç.tex");
        assert_eq!(name("图.tex".as_bytes(), false), "图.tex");
    }

    fn base64_decode(text: &str) -> Vec<u8> {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD
            .decode(text.split_whitespace().collect::<String>())
            .unwrap()
    }

    const FIXTURE: &str = include_str!("../tests/fixtures/manuscript.zip.b64");
}
