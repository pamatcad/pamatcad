mod rpc;
mod websocket;

use pamatcad_core::{
    error::Result,
    protocol::{Request, Response},
    Engine,
};
use tokio::sync::{mpsc, oneshot};

enum Job {
    Execute {
        session: u64,
        request: Request,
        reply: oneshot::Sender<Result<Response>>,
    },
    Disconnect(u64),
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
                match job {
                    Job::Execute {
                        session,
                        request,
                        reply,
                    } => {
                        let _ = reply.send(engine.execute_for(session, request));
                    }
                    Job::Disconnect(id) => engine.end_session(id),
                }
            }
        });
        Self { sender }
    }
}

impl Host {
    pub async fn execute(
        &self,
        request: Request,
    ) -> std::result::Result<Result<Response>, &'static str> {
        self.execute_for(0, request).await
    }

    async fn disconnect(&self, session: u64) {
        let _ = self.sender.send(Job::Disconnect(session)).await;
    }

    async fn execute_for(
        &self,
        session: u64,
        request: Request,
    ) -> std::result::Result<Result<Response>, &'static str> {
        let (reply, receiver) = oneshot::channel();
        self.sender
            .send(Job::Execute {
                session,
                request,
                reply,
            })
            .await
            .map_err(|_| "Core worker stopped")?;
        receiver.await.map_err(|_| "Core worker stopped")
    }
}

pub use websocket::serve;
