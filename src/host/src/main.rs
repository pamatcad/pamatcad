use clap::{Parser, Subcommand};
use std::{net::SocketAddr, path::PathBuf};

#[derive(Parser)]
#[command(name = "pamatcad", version, about = "PamatCAD headless modeling core")]
struct Arguments {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Run the native core over WebSocket JSON-RPC.
    Serve {
        #[arg(long, default_value = "ws", value_parser = ["ws"])]
        transport: String,
        #[arg(long, default_value = "127.0.0.1:8787")]
        listen: SocketAddr,
    },
    /// Generate the SDK's protocol types from the Rust contract.
    Bindings {
        #[arg(long)]
        output: PathBuf,
    },
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    match Arguments::parse().command {
        Command::Serve { listen, .. } => pamatcad_host::serve(listen).await?,
        Command::Bindings { output } => {
            let bindings = pamatcad_core::protocol::typescript();
            if std::fs::read_to_string(&output).ok().as_deref() != Some(&bindings) {
                if let Some(parent) = output.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                std::fs::write(output, bindings)?;
            }
        }
    }
    Ok(())
}
