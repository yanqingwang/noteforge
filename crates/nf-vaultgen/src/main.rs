use clap::{Parser, Subcommand};
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "nf-vaultgen", about = "NoteForge test vault generator")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Generate a test vault
    Generate {
        /// Built-in profile name
        #[arg(long, default_value = "smoke")]
        profile: String,

        /// Random seed for deterministic generation
        #[arg(long, default_value_t = 42)]
        seed: u64,

        /// Output directory for vault files
        #[arg(long, short)]
        out: PathBuf,
    },

    /// Verify a generated vault against its manifest
    Verify {
        /// Vault directory (containing vault/ subdir)
        #[arg(long)]
        vault: PathBuf,

        /// Manifest directory (containing manifest/ subdir)
        #[arg(long)]
        manifest: PathBuf,
    },

    /// List available built-in profiles
    ListProfiles {
        /// Output as JSON
        #[arg(long)]
        json: bool,
    },
}

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();

    match cli.command {
        Command::Generate {
            profile,
            seed,
            out,
        } => {
            println!("Generating vault: profile={profile}, seed={seed}, out={}", out.display());
            let summary = nf_vaultgen::generate(&profile, seed, &out)?;
            println!("Done! Generated {} notes", summary.counts.notes);
            println!("  Links: {} total, {} resolved, {} broken",
                summary.counts.links_total,
                summary.counts.links_resolved,
                summary.counts.links_broken,
            );
            println!("  Orphans: {}", summary.counts.orphan_notes);
            println!("  Manifest: {}/manifest", out.display());
        }

        Command::Verify { vault, manifest } => {
            println!(
                "Verifying vault at {} against manifest at {}",
                vault.display(),
                manifest.display()
            );
            nf_vaultgen::verify::verify_vault(&vault, &manifest)?;
            println!("✅ Verification passed: all invariants satisfied");
        }

        Command::ListProfiles { json } => {
            let profiles = nf_vaultgen::profiles::list_builtin_profiles();
            if json {
                println!("{}", serde_json::to_string_pretty(&profiles)?);
            } else {
                println!("Built-in profiles:");
                for p in &profiles {
                    println!("  - {p}");
                }
            }
        }
    }

    Ok(())
}
