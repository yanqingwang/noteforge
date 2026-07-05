use clap::{Parser, Subcommand};
use nf_vault::Vault;
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "noteforge", about = "NoteForge knowledge manager")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Open a vault and show file tree
    Open {
        #[arg(help = "Path to vault folder")]
        path: PathBuf,
    },
    /// Show a note's content with parsed metadata
    Show {
        #[arg(help = "Path to vault folder")]
        vault: PathBuf,
        #[arg(help = "Relative path to note file")]
        note: String,
    },
    /// Render note to styled output
    Render {
        #[arg(help = "Path to vault folder")]
        vault: PathBuf,
        #[arg(help = "Relative path to note file")]
        note: String,
    },
    /// Index the vault and print stats
    Info {
        #[arg(help = "Path to vault folder")]
        vault: PathBuf,
    },
}

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();

    match cli.command {
        Command::Open { path } => cmd_open(path),
        Command::Show { vault, note } => cmd_show(vault, note),
        Command::Render { vault, note } => cmd_render(vault, note),
        Command::Info { vault } => cmd_info(vault),
    }
}

fn cmd_open(path: PathBuf) -> anyhow::Result<()> {
    let vault = Vault::open(&path)?;
    println!("Vault: {}", vault.root().display());
    println!("Config: name={}", vault.config().name);
    println!();
    println!("File tree:");
    let tree = vault.file_tree()?;
    for entry in &tree {
        let icon = if entry.is_dir { "📁" } else if entry.path.ends_with(".md") { "📝" } else { "📎" };
        println!("  {} {}", icon, entry.path);
    }
    println!();
    let notes = tree.iter().filter(|e| e.path.ends_with(".md")).count();
    let files = tree.iter().filter(|e| !e.is_dir).count();
    println!("{} notes, {} total files, {} dirs", notes, files, tree.len() - files);
    Ok(())
}

fn cmd_show(vault: PathBuf, note: String) -> anyhow::Result<()> {
    let vault = Vault::open(&vault)?;
    let content = vault.read_note(&note)?;
    let text = String::from_utf8_lossy(&content);
    let meta = nf_markdown::parse_to_meta(&note, &content);

    println!("Note: {}", note);
    println!("Size: {} bytes", meta.size);
    println!("SHA-256: {}", meta.sha256);
    println!("Line ending: {}", meta.line_ending);

    if !meta.frontmatter.fields.is_empty() {
        println!("\nFrontmatter:");
        for (k, v) in &meta.frontmatter.fields {
            println!("  {} = {}", k, v);
        }
    }

    if !meta.headings.is_empty() {
        println!("\nHeadings:");
        for h in &meta.headings {
            println!("  {} {}", "#".repeat(h.level as usize), h.text);
        }
    }

    if !meta.links_out.is_empty() {
        println!("\nLinks:");
        for l in &meta.links_out {
            if let Some(ref d) = l.display {
                println!("  [[{}|{}]]", l.target, d);
            } else if let Some(ref s) = l.subpath {
                println!("  [[{}{}]]", l.target, s);
            } else {
                println!("  [[{}]]", l.target);
            }
        }
    }

    if !meta.tags_inline.is_empty() {
        println!("\nTags:");
        for t in &meta.tags_inline {
            println!("  #{}", t.tag);
        }
    }

    if !meta.block_ids.is_empty() {
        println!("\nBlock IDs: {}", meta.block_ids.len());
    }

    println!("\n--- Content Preview ---");
    for line in text.lines().take(20) {
        println!("{}", line);
    }
    if text.lines().count() > 20 {
        println!("... ({} more lines)", text.lines().count() - 20);
    }

    Ok(())
}

fn cmd_render(vault: PathBuf, note: String) -> anyhow::Result<()> {
    let vault = Vault::open(&vault)?;
    let content = vault.read_note(&note)?;
    let text = String::from_utf8_lossy(&content);
    let lines = nf_render::render(&text);

    println!("Rendered output for: {}\n", note);
    for line in &lines {
        let _indent = "  ".repeat(line.indent as usize);
        for seg in &line.segments {
            let style = match seg.style {
                nf_render::Style::Heading(l) => format!("\x1b[1;{}m", if l <= 2 { 34 } else { 36 }),
                nf_render::Style::Bold => "\x1b[1m".into(),
                nf_render::Style::Code => "\x1b[33m".into(),
                nf_render::Style::Link => "\x1b[34m\x1b[4m".into(),
                nf_render::Style::List => "\x1b[32m".into(),
                nf_render::Style::Quote => "\x1b[90m".into(),
                _ => "\x1b[0m".into(),
            };
            print!("{}{}{}", style, seg.text, "\x1b[0m");
        }
        println!();
    }
    Ok(())
}

fn cmd_info(vault: PathBuf) -> anyhow::Result<()> {
    let vault = Vault::open(&vault)?;
    let tree = vault.file_tree()?;
    let notes = tree.iter().filter(|e| e.path.ends_with(".md")).count();
    let dirs = tree.iter().filter(|e| e.is_dir).count();
    let files = tree.len() - dirs;
    let total_size: u64 = tree.iter().filter(|e| !e.is_dir).map(|e| e.size).sum();

    println!("NoteForge Vault Info");
    println!("===================");
    println!("Path:  {}", vault.root().display());
    println!("Name:  {}", vault.config().name);
    println!("Notes: {}", notes);
    println!("Files: {}", files);
    println!("Dirs:  {}", dirs);
    println!("Size:  {} bytes ({:.1} KB)", total_size, total_size as f64 / 1024.0);
    Ok(())
}
