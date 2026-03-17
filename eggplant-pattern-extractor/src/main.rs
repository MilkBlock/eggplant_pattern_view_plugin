use std::{fs, io::Read, path::PathBuf};

use anyhow::{Context, Result};
use clap::Parser;
use eggplant_pattern_extractor::{ExtractOptions, extract_pattern};
use ra_ap_syntax::Edition;

#[derive(Debug, Parser)]
struct Cli {
    #[arg(long)]
    file: Option<PathBuf>,
    #[arg(long)]
    offset: usize,
    #[arg(long, default_value = "2024")]
    edition: Edition,
    #[arg(long, default_value_t = false)]
    pretty: bool,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let source = read_source(cli.file)?;
    let pattern = extract_pattern(
        &source,
        ExtractOptions {
            offset: cli.offset,
            edition: cli.edition,
        },
    )?;

    if cli.pretty {
        println!("{}", serde_json::to_string_pretty(&pattern)?);
    } else {
        println!("{}", serde_json::to_string(&pattern)?);
    }

    Ok(())
}

fn read_source(path: Option<PathBuf>) -> Result<String> {
    match path {
        Some(path) => fs::read_to_string(&path)
            .with_context(|| format!("failed to read source file {}", path.display())),
        None => {
            let mut input = String::new();
            std::io::stdin()
                .read_to_string(&mut input)
                .context("failed to read source from stdin")?;
            Ok(input)
        }
    }
}
