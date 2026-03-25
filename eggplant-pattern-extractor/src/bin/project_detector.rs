use std::path::PathBuf;

use anyhow::Result;
use clap::Parser;
use eggplant_pattern_extractor::project_detector::check_project;
use ra_ap_syntax::Edition;

#[derive(Debug, Parser)]
struct Cli {
    #[arg(long, default_value = ".")]
    root: PathBuf,
    #[arg(long, default_value = "2024")]
    edition: Edition,
    #[arg(long, default_value_t = false)]
    json: bool,
    #[arg(long, default_value_t = false)]
    fail_on_error: bool,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let report = check_project(&cli.root, cli.edition)?;

    if cli.json {
        println!("{}", serde_json::to_string_pretty(&report)?);
    } else {
        print_text_report(&report);
    }

    if cli.fail_on_error && report.failed > 0 {
        std::process::exit(1);
    }

    Ok(())
}

fn print_text_report(report: &eggplant_pattern_extractor::project_detector::ProjectCheckReport) {
    println!(
        "Checked {} rule(s) across {} Rust file(s) under {}",
        report.rules_total,
        report.rust_files,
        report.root.display()
    );
    println!("Passed: {}", report.passed);
    println!("Failed: {}", report.failed);

    if report.failed == 0 {
        return;
    }

    println!();
    println!("Failures:");
    for result in report.results.iter().filter(|result| !result.ok) {
        let rule_label = result.rule_name.as_deref().unwrap_or("<unnamed>");
        println!(
            "- {}:{}:{} {} ({})",
            result.file.display(),
            result.line,
            result.column,
            rule_label,
            result.callee
        );
        if let Some(error) = &result.error {
            println!("  {}", error);
        }
    }
}
