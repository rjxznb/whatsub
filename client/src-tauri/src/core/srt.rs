use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SrtCue {
    pub index: usize,
    pub time: f64,
    pub end_time: f64,
    pub text: String,
}

pub fn parse(content: &str) -> Result<Vec<SrtCue>, String> {
    let normalized = content.replace("\r\n", "\n");
    let mut cues = Vec::new();
    let blocks: Vec<&str> = normalized
        .split("\n\n")
        .filter(|b| !b.trim().is_empty())
        .collect();

    for block in blocks {
        let lines: Vec<&str> = block.lines().collect();
        if lines.len() < 3 {
            continue;
        }
        let index: usize = lines[0]
            .trim()
            .parse()
            .map_err(|e: std::num::ParseIntError| e.to_string())?;
        let (time, end_time) = parse_timecode_line(lines[1])?;
        let text = lines[2..].join(" ").trim().to_string();
        cues.push(SrtCue {
            index,
            time,
            end_time,
            text,
        });
    }

    Ok(cues)
}

fn parse_timecode_line(line: &str) -> Result<(f64, f64), String> {
    let parts: Vec<&str> = line.split("-->").collect();
    if parts.len() != 2 {
        return Err(format!("invalid timecode line: {line}"));
    }
    Ok((parse_timecode(parts[0].trim())?, parse_timecode(parts[1].trim())?))
}

fn parse_timecode(t: &str) -> Result<f64, String> {
    let normalized = t.replace(',', ".");
    let parts: Vec<&str> = normalized.split(':').collect();
    if parts.len() != 3 {
        return Err(format!("invalid timecode: {t}"));
    }
    let h: f64 = parts[0]
        .parse()
        .map_err(|e: std::num::ParseFloatError| e.to_string())?;
    let m: f64 = parts[1]
        .parse()
        .map_err(|e: std::num::ParseFloatError| e.to_string())?;
    let s: f64 = parts[2]
        .parse()
        .map_err(|e: std::num::ParseFloatError| e.to_string())?;
    Ok(h * 3600.0 + m * 60.0 + s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_single_cue() {
        let srt = "1\n00:00:01,000 --> 00:00:03,500\nHello world\n";
        let cues = parse(srt).unwrap();
        assert_eq!(cues.len(), 1);
        assert_eq!(cues[0].index, 1);
        assert_eq!(cues[0].time, 1.0);
        assert_eq!(cues[0].end_time, 3.5);
        assert_eq!(cues[0].text, "Hello world");
    }

    #[test]
    fn parses_multiple_cues() {
        let srt = "1\n00:00:01,000 --> 00:00:03,500\nFirst\n\n2\n00:00:04,200 --> 00:00:06,800\nSecond line\nstill second\n";
        let cues = parse(srt).unwrap();
        assert_eq!(cues.len(), 2);
        assert_eq!(cues[1].text, "Second line still second");
    }

    #[test]
    fn handles_hour_timecodes() {
        let srt = "1\n01:02:03,456 --> 01:02:05,000\nLater\n";
        let cues = parse(srt).unwrap();
        assert_eq!(cues[0].time, 3723.456);
    }

    #[test]
    fn rejects_invalid_timecode() {
        let srt = "1\nbroken\nText\n";
        assert!(parse(srt).is_err());
    }

    #[test]
    fn handles_crlf() {
        let srt = "1\r\n00:00:01,000 --> 00:00:02,000\r\nHi\r\n";
        let cues = parse(srt).unwrap();
        assert_eq!(cues[0].text, "Hi");
    }
}
