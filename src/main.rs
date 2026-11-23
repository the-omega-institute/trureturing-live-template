use chrono::{DateTime, Utc};
use clap::{Parser, Subcommand};
use live_harness::{Result, adapters, github, model::*, project, reduce, store};
use std::path::PathBuf;

#[derive(Parser)]
#[command(
    version,
    about = "Source-bound event harness for live AI organizations"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}
#[derive(Subcommand)]
enum Command {
    Check {
        #[arg(long)]
        config: PathBuf,
    },
    Collect {
        #[arg(long)]
        config: PathBuf,
        #[arg(long)]
        state: PathBuf,
        #[arg(long)]
        output: PathBuf,
    },
    Ingest {
        #[arg(long)]
        config: PathBuf,
        #[arg(long)]
        input: PathBuf,
        #[arg(long)]
        state: PathBuf,
        #[arg(long)]
        output: PathBuf,
    },
    ImportGithub {
        #[arg(long)]
        config: PathBuf,
        #[arg(long)]
        input: PathBuf,
        #[arg(long)]
        at: DateTime<Utc>,
        #[arg(long)]
        state: PathBuf,
        #[arg(long)]
        output: PathBuf,
    },
    ImportCma {
        #[arg(long)]
        config: PathBuf,
        #[arg(long)]
        input: PathBuf,
        #[arg(long)]
        at: DateTime<Utc>,
        #[arg(long)]
        state: PathBuf,
        #[arg(long)]
        output: PathBuf,
    },
    ImportNyxid {
        #[arg(long)]
        config: PathBuf,
        #[arg(long)]
        input: PathBuf,
        #[arg(long)]
        at: DateTime<Utc>,
        #[arg(long)]
        state: PathBuf,
        #[arg(long)]
        output: PathBuf,
    },
    Project {
        #[arg(long)]
        config: PathBuf,
        #[arg(long)]
        state: PathBuf,
        #[arg(long)]
        at: DateTime<Utc>,
        #[arg(long)]
        output: PathBuf,
    },
    Replay {
        #[arg(long)]
        config: PathBuf,
        #[arg(long)]
        input: PathBuf,
        #[arg(long)]
        output: PathBuf,
    },
}
fn run() -> Result<()> {
    match Cli::parse().command {
        Command::Check { config } => {
            live_harness::validate_config(&store::read_json(&config)?)?;
            println!("configuration valid");
        }
        Command::Collect {
            config,
            state,
            output,
        } => {
            let config: Config = store::read_json(&config)?;
            let collection = github::collect(
                &config,
                std::env::var("GH_TOKEN")
                    .or_else(|_| std::env::var("GITHUB_TOKEN"))
                    .unwrap_or_default(),
            )?;
            let view = store::transaction(&config, &state, &output, |_| Ok(collection.ingest))?;
            eprintln!(
                "{}",
                serde_json::json!({"observed_at":view.observed_at,"requests":collection.requests,"failures":collection.failures})
            );
        }
        Command::Ingest {
            config,
            input,
            state,
            output,
        } => {
            let config = store::read_json(&config)?;
            let input = store::read_json(&input)?;
            store::transaction(&config, &state, &output, |_| Ok(input))?;
        }
        Command::ImportGithub {
            config,
            input,
            at,
            state,
            output,
        } => {
            let config = store::read_json(&config)?;
            let rows: Vec<adapters::GithubObservation> = store::read_json(&input)?;
            let batches = rows
                .into_iter()
                .map(|row| adapters::github(&config, row))
                .collect::<Result<Vec<_>>>()?;
            store::transaction(&config, &state, &output, |_| {
                Ok(Ingest { as_of: at, batches })
            })?;
        }
        Command::ImportCma {
            config,
            input,
            at,
            state,
            output,
        } => {
            let config = store::read_json(&config)?;
            let page = store::read_json(&input)?;
            store::transaction(&config, &state, &output, |previous| {
                Ok(Ingest {
                    as_of: at,
                    batches: vec![adapters::cma(&config, page, previous)?],
                })
            })?;
        }
        Command::ImportNyxid {
            config,
            input,
            at,
            state,
            output,
        } => {
            let config = store::read_json(&config)?;
            let receipt = store::read_json(&input)?;
            store::transaction(&config, &state, &output, |_| {
                Ok(Ingest {
                    as_of: at,
                    batches: vec![adapters::nyxid(&config, receipt)?],
                })
            })?;
        }
        Command::Project {
            config,
            state,
            at,
            output,
        } => {
            let config = store::read_json(&config)?;
            let previous = store::read_json(&state)?;
            let current = reduce(
                &config,
                Some(&previous),
                &Ingest {
                    as_of: at,
                    batches: vec![],
                },
            )?;
            store::atomic_json(&output, &project(&config, &current)?)?;
        }
        Command::Replay {
            config,
            input,
            output,
        } => {
            let config = store::read_json(&config)?;
            let inputs: Vec<Ingest> = store::read_json(&input)?;
            let mut state = None;
            for input in inputs {
                state = Some(reduce(&config, state.as_ref(), &input)?);
            }
            let state = state.ok_or_else(|| {
                live_harness::Error::Contract("replay needs at least one transaction".into())
            })?;
            store::atomic_json(&output, &project(&config, &state)?)?;
        }
    }
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
