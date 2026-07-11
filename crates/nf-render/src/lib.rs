


/// A styled text segment for rendering.
#[derive(Debug, Clone)]
pub struct StyledSegment {
    pub text: String,
    pub style: Style,
}

/// Text style for rendering.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Style {
    Normal,
    Heading(u8),
    Bold,
    Italic,
    Code,
    Link,
    List,
    Quote,
    Strikethrough,
}

/// A rendered line of content.
#[derive(Debug, Clone)]
pub struct RenderedLine {
    pub segments: Vec<StyledSegment>,
    pub indent: u8,
}

/// Render parsed markdown to styled segments for GUI display.
pub fn render(content: &str) -> Vec<RenderedLine> {
    let _parsed = nf_markdown::parse(content);
    let mut lines = Vec::new();

    for line in content.lines() {
        let trimmed = line.trim_start();
        let indent = (line.len() - trimmed.len()) as u8;

        if trimmed.starts_with("---") {
            continue; // skip frontmatter markers
        }

        if let Some(h_text) = trimmed.strip_prefix('#') {
            let level = trimmed.chars().take_while(|c| *c == '#').count();
            let text = h_text.trim_start().to_string();
            lines.push(RenderedLine {
                segments: vec![StyledSegment { text, style: Style::Heading(level as u8) }],
                indent,
            });
            continue;
        }

        if trimmed.starts_with("```") {
            lines.push(RenderedLine {
                segments: vec![StyledSegment {
                    text: trimmed.to_string(),
                    style: Style::Code,
                }],
                indent,
            });
            continue;
        }

        if trimmed.starts_with('>') {
            lines.push(RenderedLine {
                segments: vec![StyledSegment {
                    text: trimmed[1..].trim_start().to_string(),
                    style: Style::Quote,
                }],
                indent,
            });
            continue;
        }

        if trimmed.starts_with("- ") || trimmed.starts_with("* ") || trimmed.starts_with("+ ") {
            let text = trimmed[2..].to_string();
            lines.push(RenderedLine {
                segments: vec![StyledSegment { text, style: Style::List }],
                indent,
            });
            continue;
        }

        if let Some(n) = trimmed.find(|c: char| c.is_ascii_digit()) {
            if n == 0 && trimmed.contains(". ") {
                let text = trimmed.splitn(2, ". ").nth(1).unwrap_or("").to_string();
                lines.push(RenderedLine {
                    segments: vec![StyledSegment { text, style: Style::List }],
                    indent,
                });
                continue;
            }
        }

        // Parse inline formatting
        let segments = parse_inline(trimmed);
        lines.push(RenderedLine { segments, indent });
    }

    lines
}

fn parse_inline(text: &str) -> Vec<StyledSegment> {
    let mut segments = Vec::new();
    let mut remaining = text;

    while !remaining.is_empty() {
        if let Some(pos) = remaining.find("[[") {
            // Text before the link
            if pos > 0 {
                segments.push(StyledSegment {
                    text: remaining[..pos].to_string(),
                    style: Style::Normal,
                });
            }
            // Link content
            if let Some(end) = remaining[pos..].find("]]") {
                let link_text = remaining[pos + 2..pos + end].to_string();
                segments.push(StyledSegment {
                    text: link_text,
                    style: Style::Link,
                });
                remaining = &remaining[pos + end + 2..];
                continue;
            }
            remaining = &remaining[pos + 2..];
            continue;
        }

        if remaining.starts_with("**") {
            if let Some(end) = remaining[2..].find("**") {
                segments.push(StyledSegment {
                    text: remaining[2..2 + end].to_string(),
                    style: Style::Bold,
                });
                remaining = &remaining[4 + end..];
                continue;
            }
        }

        if remaining.starts_with('*') || remaining.starts_with('_') {
            let c = remaining.chars().next().unwrap();
            if let Some(end) = remaining[1..].find(c) {
                segments.push(StyledSegment {
                    text: remaining[1..1 + end].to_string(),
                    style: Style::Italic,
                });
                remaining = &remaining[2 + end..];
                continue;
            }
        }

        if remaining.starts_with('`') {
            if let Some(end) = remaining[1..].find('`') {
                segments.push(StyledSegment {
                    text: remaining[1..1 + end].to_string(),
                    style: Style::Code,
                });
                remaining = &remaining[2 + end..];
                continue;
            }
        }

        if remaining.starts_with("~~") {
            if let Some(end) = remaining[2..].find("~~") {
                segments.push(StyledSegment {
                    text: remaining[2..2 + end].to_string(),
                    style: Style::Strikethrough,
                });
                remaining = &remaining[4 + end..];
                continue;
            }
        }

        let next_special = remaining
            .find(|c| c == '*' || c == '_' || c == '`' || c == '[' || c == '~')
            .unwrap_or(remaining.len());
        if next_special > 0 {
            segments.push(StyledSegment {
                text: remaining[..next_special].to_string(),
                style: Style::Normal,
            });
            remaining = &remaining[next_special..];
        } else {
            segments.push(StyledSegment {
                text: remaining.to_string(),
                style: Style::Normal,
            });
            break;
        }
    }

    segments
}



/// Render Markdown to HTML using comrak with GFM extensions.
/// Pre-processes wikilinks [[target]] and callouts > [!type] before rendering.
pub fn render_html(content: &str) -> String {
    let mut processed = String::with_capacity(content.len());
    let chars: Vec<char> = content.chars().collect();
    let mut i = 0;
    let is_image_ext = |s: &str| {
        let lower = s.to_lowercase();
        lower.ends_with(".png") || lower.ends_with(".jpg") || lower.ends_with(".jpeg")
            || lower.ends_with(".gif") || lower.ends_with(".svg") || lower.ends_with(".webp")
            || lower.ends_with(".bmp") || lower.ends_with(".ico")
    };
    while i < chars.len() {
        // !![[image.png]] for embedded images via wikilink
        if i + 3 < chars.len() && chars[i] == '!' && chars[i+1] == '[' && chars[i+2] == '[' {
            let mut end = i + 3;
            while end + 1 < chars.len() {
                if chars[end] == ']' && chars[end+1] == ']' { break; }
                end += 1;
            }
            if end + 1 < chars.len() {
                let inner: String = chars[i+3..end].iter().collect();
                let target = inner.split('|').next().unwrap_or(&inner).to_string();
                if is_image_ext(&target) {
                    processed.push_str(&format!("<img src=\"note://{}\" alt=\"{}\" style=\"max-width:100%\"/>", target, target));
                } else {
                    processed.push_str(&format!("<a href=\"note://{}\">{}</a>", target, target));
                }
                i = end + 2;
                continue;
            }
        }
        // [[wikilink]] for regular links
        if i + 1 < chars.len() && chars[i] == '[' && chars[i+1] == '[' {
            // Find closing ]]
            let mut end = i + 2;
            while end + 1 < chars.len() {
                if chars[end] == ']' && chars[end+1] == ']' { break; }
                end += 1;
            }
            if end + 1 < chars.len() {
                let inner: String = chars[i+2..end].iter().collect();
                let (target, display) = if let Some(pipe) = inner.find('|') {
                    (&inner[..pipe], Some(&inner[pipe+1..]))
                } else {
                    (inner.as_str(), None)
                };
                let clean_target = target.split('#').next().unwrap_or(target);
                let label = display.unwrap_or(target);
                processed.push_str(&format!("[{}](note://{})", label, clean_target));
                i = end + 2;
                continue;
            }
        }
        processed.push(chars[i]);
        i += 1;
    }

    let mut options = comrak::ComrakOptions::default();
    options.extension.strikethrough = true;
    options.extension.tagfilter = true;
    options.extension.table = true;
    options.extension.autolink = true;
    options.extension.tasklist = true;
    options.extension.header_ids = Some("user-content-".into());
    options.extension.footnotes = true;
    options.render.github_pre_lang = true;
    options.render.width = 0;
    options.parse.smart = true;
    let html = comrak::markdown_to_html(&processed, &options);

    html
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_render_chinese() {
        let html = render_html("# 测试中文标题\n\n这是一段中文内容，包含[[内部链接]]。");
        assert!(html.contains("测试中文标题"));
        assert!(html.contains("内部链接"));
    }
    #[test]
    fn test_render_empty() {
        let lines = render("");
        assert!(lines.is_empty());
    }

    #[test]
    fn test_render_heading() {
        let lines = render("# Hello");
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].segments[0].style, Style::Heading(1));
    }

    #[test]
    fn test_render_bold() {
        let segments = parse_inline("text **bold** more");
        assert_eq!(segments.len(), 3);
        assert_eq!(segments[0].style, Style::Normal);
        assert_eq!(segments[1].style, Style::Bold);
        assert_eq!(segments[1].text, "bold");
        assert_eq!(segments[2].style, Style::Normal);
    }

    #[test]
    fn test_render_link() {
        let segments = parse_inline("text [[link]] more");
        assert_eq!(segments.len(), 3);
        assert_eq!(segments[1].style, Style::Link);
        assert_eq!(segments[1].text, "link");
    }

    #[test]
    fn test_render_code() {
        let segments = parse_inline("text `code` more");
        assert_eq!(segments.len(), 3);
        assert_eq!(segments[1].style, Style::Code);
    }

    #[test]
    fn test_render_list() {
        let lines = render("- item");
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].segments[0].style, Style::List);
    }

    #[test]
    fn test_render_quote() {
        let lines = render("> quoted text");
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].segments[0].style, Style::Quote);
    }
}
