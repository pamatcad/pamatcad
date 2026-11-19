use crate::Host;
use pamatcad_core::protocol::{Request, METHODS};
use serde_json::{json, Value};

fn error(id: Value, code: i32, message: &str, data: Option<Value>) -> Value {
    let mut error = json!({ "code": code, "message": message });
    if let Some(data) = data {
        error["data"] = data;
    }
    json!({ "jsonrpc": "2.0", "id": id, "error": error })
}

pub async fn handle(host: &Host, session: u64, text: &str) -> Option<Value> {
    let request: Value = match serde_json::from_str(text) {
        Ok(request) => request,
        Err(_) => return Some(error(Value::Null, -32700, "Invalid JSON", None)),
    };
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let valid_id = id.is_null() || id.is_string() || id.is_number();
    let Some(method) = request.get("method").and_then(Value::as_str) else {
        return Some(error(Value::Null, -32600, "Invalid JSON-RPC request", None));
    };
    if request.get("jsonrpc").and_then(Value::as_str) != Some("2.0") || !valid_id {
        return Some(error(Value::Null, -32600, "Invalid JSON-RPC request", None));
    }
    let notification = request.get("id").is_none();
    let result = if !METHODS.contains(&method) {
        error(id, -32601, "Unknown method", None)
    } else {
        let command = serde_json::from_value::<Request>(json!({
            "method": method,
            "params": request.get("params").cloned().unwrap_or_else(|| json!({})),
        }));
        match command {
            Err(failure) => error(id, -32602, &failure.to_string(), None),
            Ok(command) => match host.execute_for(session, command).await {
                Err(message) => error(id, -32603, message, None),
                Ok(Err(failure)) => error(id, -32000, &failure.message, Some(json!(failure))),
                Ok(Ok(response)) => {
                    let response = serde_json::to_value(response)
                        .expect("Core responses contain finite values");
                    json!({ "jsonrpc": "2.0", "id": id, "result": response["value"] })
                }
            },
        }
    };
    if notification {
        None
    } else {
        Some(result)
    }
}
