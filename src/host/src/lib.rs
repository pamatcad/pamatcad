mod rpc;
mod websocket;

use pamatcad_core::{
    error::Result,
    protocol::{Request, Response},
    Engine,
};
use tokio::sync::{mpsc, oneshot};

struct Job {
    request: Request,
    reply: oneshot::Sender<Result<Response>>,
}

#[derive(Clone)]
pub struct Host {
    sender: mpsc::Sender<Job>,
}

impl Default for Host {
    fn default() -> Self {
        let (sender, mut receiver) = mpsc::channel::<Job>(32);
        std::thread::spawn(move || {
            // OCCT shapes never cross thread boundaries; requests are serialized here.
            let mut engine = Engine::default();
            while let Some(job) = receiver.blocking_recv() {
                let _ = job.reply.send(engine.execute(job.request));
            }
        });
        Self { sender }
    }
}

impl Host {
    async fn execute(
        &self,
        request: Request,
    ) -> std::result::Result<Result<Response>, &'static str> {
        let (reply, receiver) = oneshot::channel();
        self.sender
            .send(Job { request, reply })
            .await
            .map_err(|_| "Core worker stopped")?;
        receiver.await.map_err(|_| "Core worker stopped")
    }
}

pub use websocket::serve;
