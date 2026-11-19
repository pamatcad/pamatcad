use crate::{rpc, Host};
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    response::Response,
    routing::get,
    Router,
};
use std::net::SocketAddr;
use tokio::net::TcpListener;

async fn upgrade(ws: WebSocketUpgrade, State(host): State<Host>) -> Response {
    ws.max_message_size(1024 * 1024)
        .on_upgrade(move |socket| connection(socket, host))
}

async fn connection(mut socket: WebSocket, host: Host) {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT_SESSION: AtomicU64 = AtomicU64::new(1);
    let session = NEXT_SESSION.fetch_add(1, Ordering::Relaxed);
    while let Some(Ok(message)) = socket.recv().await {
        match message {
            Message::Text(text) => {
                if let Some(response) = rpc::handle(&host, session, &text).await {
                    if socket
                        .send(Message::Text(response.to_string().into()))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }
    host.disconnect(session).await;
}

pub async fn serve(address: SocketAddr) -> std::io::Result<()> {
    let listener = TcpListener::bind(address).await?;
    let bound = listener.local_addr()?;
    let app = Router::new()
        .route("/rpc", get(upgrade))
        .with_state(Host::default());
    // A machine-readable readiness event; diagnostics belong on stderr.
    println!(
        "{}",
        serde_json::json!({"event": "ready", "url": format!("ws://{bound}/rpc")})
    );
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
}
