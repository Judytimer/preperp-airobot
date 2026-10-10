use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    env,
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, State, WindowEvent,
};

const LAYA_DEFAULT_ENDPOINT: &str = "http://127.0.0.1:8000";
const WATCHER_FRESH_MS: u64 = 150_000;
const TESTNET_RUNNER_FRESH_MS: u64 = 20_000;
const SUPERVISOR_CADENCE_MS: u64 = 30_000;

struct AppState {
    runtime: RuntimePaths,
    workspace_root: PathBuf,
    laya_endpoint: String,
    laya_child: Mutex<Option<Child>>,
    watcher_child: Mutex<Option<Child>>,
    testnet_child: Mutex<Option<Child>>,
    client: reqwest::Client,
    started_at: u64,
}

#[derive(Clone)]
struct RuntimePaths {
    mode: &'static str,
    data_root: PathBuf,
    evidence_root: PathBuf,
    state_root: PathBuf,
    log_root: PathBuf,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemStatus {
    observed_at: u64,
    build: BuildStatus,
    runtime: RuntimeStatus,
    laya: LayaStatus,
    laya_review: LayaReviewStatus,
    watcher: WatcherStatus,
    hourly_watcher: HourlyWatcherStatus,
    latest_candidate: Option<CandidateStatus>,
    prediction_testnet: PredictionTestnetStatus,
    supervisor: SupervisorStatus,
    authority: AuthorityStatus,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SupervisorStatus {
    resident: bool,
    started_at: u64,
    cadence_ms: u64,
    cloud_ai_required: bool,
    laya_local_only: bool,
    testnet_auto_arm: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BuildStatus {
    version: &'static str,
    commit: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeStatus {
    mode: &'static str,
    data_root: String,
    evidence_root: String,
    state_root: String,
    log_root: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LayaStatus {
    phase: &'static str,
    endpoint: String,
    loaded_models: Vec<String>,
    device: Option<String>,
    detail: Option<String>,
}

#[derive(Deserialize)]
struct LayaHealth {
    status: String,
    #[serde(default)]
    loaded: Vec<String>,
    device: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LayaReviewStatus {
    phase: &'static str,
    reviewed_at: Option<u64>,
    candidate_id: Option<String>,
    choice: Option<String>,
    confidence: Option<f64>,
    answer_confidence: Option<f64>,
    inference_ms: Option<f64>,
    model: Option<String>,
    artifact_path: Option<String>,
    detail: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WatcherStatus {
    phase: &'static str,
    process_alive: bool,
    latest_cycle_at: Option<u64>,
    latest_scan_path: Option<String>,
    discovered_episodes: u64,
    registered_episodes: u64,
    admission: Option<AdmissionStatus>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AdmissionStatus {
    waiting: u64,
    qualified: u64,
    data_blocked: u64,
    not_triggered: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HourlyWatcherStatus {
    phase: &'static str,
    process_alive: bool,
    latest_cycle_at: Option<u64>,
    latest_scan_path: Option<String>,
    monitored_assets: Vec<String>,
    market_supplied_assets: Vec<String>,
    discovered_episodes: u64,
    active_episodes: u64,
    admission: Option<HourlyAdmissionStatus>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HourlyAdmissionStatus {
    waiting: u64,
    qualified: u64,
    data_blocked: u64,
    expired: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PredictionTestnetStatus {
    phase: String,
    process_alive: bool,
    updated_at: Option<u64>,
    armed_at: Option<u64>,
    allowed_assets: Vec<String>,
    candidate_id: Option<String>,
    venue_symbol: Option<String>,
    evidence_path: Option<String>,
    detail: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CandidateStatus {
    variant: String,
    candidate_id: String,
    asset: String,
    direction: Option<String>,
    question: String,
    event_title: String,
    candidate_t0: u64,
    measurement_at: u64,
    selected_strike: Option<f64>,
    reference_open: Option<f64>,
    crossing_previous_close: f64,
    crossing_close: f64,
    entry_best_ask: f64,
    entry_best_ask_size: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthorityStatus {
    execution_enabled: bool,
    testnet_demo_armed: bool,
    mainnet_enabled: bool,
    laya_execution_authority: bool,
    statement: &'static str,
}

#[tauri::command]
async fn ensure_laya(state: State<'_, AppState>) -> Result<(), String> {
    ensure_laya_inner(state.inner()).await
}

async fn ensure_laya_inner(state: &AppState) -> Result<(), String> {
    if fetch_laya_health(&state.client, &state.laya_endpoint)
        .await
        .is_ok()
    {
        return Ok(());
    }
    if !is_loopback_endpoint(&state.laya_endpoint) {
        return Err("automatic Laya start is allowed only for the loopback endpoint".into());
    }

    let mut child_guard = state
        .laya_child
        .lock()
        .map_err(|_| "Laya supervisor lock is poisoned")?;
    if let Some(child) = child_guard.as_mut() {
        match child.try_wait() {
            Ok(None) => return Ok(()),
            Ok(Some(_)) | Err(_) => *child_guard = None,
        }
    }

    fs::create_dir_all(&state.runtime.log_root).map_err(error_text)?;
    let laya_root = laya_root(&state.workspace_root);
    let python = laya_root.join(".venv").join("Scripts").join("python.exe");
    if !python.is_file() {
        return Err(format!(
            "Laya Python runtime is missing: {}",
            python.display()
        ));
    }
    let stdout =
        File::create(state.runtime.log_root.join("laya-desktop.stdout.log")).map_err(error_text)?;
    let stderr =
        File::create(state.runtime.log_root.join("laya-desktop.stderr.log")).map_err(error_text)?;
    let child = Command::new(&python)
        .args(["-m", "laya.serve"])
        .current_dir(&laya_root)
        .env("LAYA_HOST", "127.0.0.1")
        .env("LAYA_PORT", "8000")
        .env("LAYA_MODELS", "english")
        .env("LAYA_PRELOAD", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr))
        .spawn()
        .map_err(error_text)?;
    *child_guard = Some(child);
    Ok(())
}

#[tauri::command]
async fn ensure_watcher(state: State<'_, AppState>) -> Result<(), String> {
    ensure_watcher_inner(state.inner()).await
}

async fn ensure_watcher_inner(state: &AppState) -> Result<(), String> {
    let owned_child_exited = {
        let mut child_guard = state
            .watcher_child
            .lock()
            .map_err(|_| "watcher supervisor lock is poisoned")?;
        if let Some(child) = child_guard.as_mut() {
            match child.try_wait() {
                Ok(None) => return Ok(()),
                Ok(Some(_)) | Err(_) => {
                    *child_guard = None;
                    true
                }
            }
        } else {
            false
        }
    };

    let observed_at = now_ms()?;
    if !owned_child_exited
        && read_watcher_status(&state.runtime.evidence_root, observed_at).phase == "RUNNING"
    {
        return Ok(());
    }

    let collector = state
        .workspace_root
        .join("src")
        .join("overlay")
        .join("price-target-collector.ts");
    if !collector.is_file() {
        return Err(format!(
            "prospective watcher entry point is missing: {}",
            collector.display()
        ));
    }
    fs::create_dir_all(&state.runtime.log_root).map_err(error_text)?;
    let stdout = File::create(state.runtime.log_root.join("price-target-watch.stdout.log"))
        .map_err(error_text)?;
    let stderr = File::create(state.runtime.log_root.join("price-target-watch.stderr.log"))
        .map_err(error_text)?;
    let mut command = Command::new("node");
    command
        .args([
            "--experimental-strip-types",
            "src/overlay/price-target-collector.ts",
            "--watch",
        ])
        .current_dir(&state.workspace_root)
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));
    if state.runtime.mode == "PACKAGED" {
        command.env("PREPERP_DATA_ROOT", &state.runtime.data_root);
    }
    let child = command.spawn().map_err(error_text)?;
    let mut child_guard = state
        .watcher_child
        .lock()
        .map_err(|_| "watcher supervisor lock is poisoned")?;
    *child_guard = Some(child);
    Ok(())
}

#[tauri::command]
async fn ensure_prediction_testnet(state: State<'_, AppState>) -> Result<(), String> {
    ensure_prediction_testnet_inner(state.inner()).await
}

async fn ensure_prediction_testnet_inner(state: &AppState) -> Result<(), String> {
    {
        let mut child_guard = state
            .testnet_child
            .lock()
            .map_err(|_| "Testnet supervisor lock is poisoned")?;
        if let Some(child) = child_guard.as_mut() {
            match child.try_wait() {
                Ok(None) => return Ok(()),
                Ok(Some(_)) | Err(_) => *child_guard = None,
            }
        }
    }

    let observed_at = now_ms()?;
    let prior = read_prediction_testnet_status(&state.runtime.state_root);
    if matches!(
        prior.phase.as_str(),
        "ROUND_TRIP_COMPLETE" | "FAILED_REVIEW_REQUIRED"
    ) {
        return Ok(());
    }
    let status_path = state
        .runtime
        .state_root
        .join("prediction-testnet-demo-status.json");
    let fresh = fs::metadata(&status_path)
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|value| {
            observed_at.saturating_sub(value.as_millis() as u64) <= TESTNET_RUNNER_FRESH_MS
        })
        .unwrap_or(false);
    if fresh
        && matches!(
            prior.phase.as_str(),
            "ARMED_WAITING_CANDIDATE" | "EXECUTING"
        )
    {
        return Ok(());
    }
    if prior.phase == "EXECUTING" {
        return Err(
            "stale EXECUTING status requires manual reconciliation; runner will not restart".into(),
        );
    }

    let runner = state
        .workspace_root
        .join("src")
        .join("overlay")
        .join("prospective-testnet-demo.ts");
    if !runner.is_file() {
        return Err(format!(
            "Prediction Testnet runner is missing: {}",
            runner.display()
        ));
    }
    let env_file = state.workspace_root.join(".env");
    if !env_file.is_file() {
        return Err("repository .env is missing; Testnet runner remains disarmed".into());
    }
    fs::create_dir_all(&state.runtime.log_root).map_err(error_text)?;
    let stdout = File::create(state.runtime.log_root.join("prediction-testnet.stdout.log"))
        .map_err(error_text)?;
    let stderr = File::create(state.runtime.log_root.join("prediction-testnet.stderr.log"))
        .map_err(error_text)?;
    let mut command = Command::new("node");
    command
        .args([
            "--env-file-if-exists=.env",
            "--experimental-strip-types",
            "--import",
            "./src/binance-testnet-clock-bootstrap.ts",
            "src/overlay/prospective-testnet-demo.ts",
        ])
        .current_dir(&state.workspace_root)
        .env("PREDICTION_TESTNET_ASSETS", "BTC,ETH,SOL,XRP,DOGE,HYPE,BNB")
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));
    if let Some(armed_at) = prior.armed_at {
        command.env("PREDICTION_TESTNET_ARMED_AT", armed_at.to_string());
    }
    if state.runtime.mode == "PACKAGED" {
        command.env("PREPERP_DATA_ROOT", &state.runtime.data_root);
    }
    let child = command.spawn().map_err(error_text)?;
    let mut child_guard = state
        .testnet_child
        .lock()
        .map_err(|_| "Testnet supervisor lock is poisoned")?;
    *child_guard = Some(child);
    Ok(())
}

#[tauri::command]
async fn system_status(state: State<'_, AppState>) -> Result<SystemStatus, String> {
    let observed_at = now_ms()?;
    let laya = match fetch_laya_health(&state.client, &state.laya_endpoint).await {
        Ok(health) if health.status == "ok" => LayaStatus {
            phase: if health.loaded.is_empty() {
                "SERVICE_READY_MODEL_COLD"
            } else {
                "MODEL_READY"
            },
            endpoint: state.laya_endpoint.clone(),
            loaded_models: health.loaded,
            device: health.device,
            detail: None,
        },
        Ok(health) => LayaStatus {
            phase: "FAILED",
            endpoint: state.laya_endpoint.clone(),
            loaded_models: health.loaded,
            device: health.device,
            detail: Some(format!("unexpected health status: {}", health.status)),
        },
        Err(detail) => {
            let starting = state
                .laya_child
                .lock()
                .ok()
                .and_then(|mut guard| {
                    guard
                        .as_mut()
                        .and_then(|child| child.try_wait().ok())
                        .map(|status| status.is_none())
                })
                .unwrap_or(false);
            LayaStatus {
                phase: if starting {
                    "SERVICE_STARTING"
                } else {
                    "OFFLINE"
                },
                endpoint: state.laya_endpoint.clone(),
                loaded_models: Vec::new(),
                device: None,
                detail: Some(detail),
            }
        }
    };

    let mut watcher = read_watcher_status(&state.runtime.evidence_root, observed_at);
    watcher.process_alive = state
        .watcher_child
        .lock()
        .ok()
        .and_then(|mut guard| {
            guard
                .as_mut()
                .and_then(|child| child.try_wait().ok())
                .map(|status| status.is_none())
        })
        .unwrap_or(false);
    if watcher.process_alive {
        watcher.phase = "RUNNING";
    }
    let mut hourly_watcher = read_hourly_watcher_status(&state.runtime.evidence_root, observed_at);
    hourly_watcher.process_alive = watcher.process_alive;
    if hourly_watcher.process_alive {
        hourly_watcher.phase = "RUNNING";
    }

    let mut prediction_testnet = read_prediction_testnet_status(&state.runtime.state_root);
    prediction_testnet.process_alive = state
        .testnet_child
        .lock()
        .ok()
        .and_then(|mut guard| {
            guard
                .as_mut()
                .and_then(|child| child.try_wait().ok())
                .map(|status| status.is_none())
        })
        .unwrap_or(false);
    if prediction_testnet.process_alive && prediction_testnet.phase == "DISARMED" {
        prediction_testnet.phase = "STARTING".into();
    }
    let testnet_demo_armed = matches!(
        prediction_testnet.phase.as_str(),
        "STARTING" | "ARMED_WAITING_CANDIDATE" | "EXECUTING"
    );

    Ok(SystemStatus {
        observed_at,
        build: BuildStatus {
            version: env!("CARGO_PKG_VERSION"),
            commit: env!("PREPERP_BUILD_COMMIT"),
        },
        runtime: RuntimeStatus {
            mode: state.runtime.mode,
            data_root: display_path(&state.runtime.data_root),
            evidence_root: display_path(&state.runtime.evidence_root),
            state_root: display_path(&state.runtime.state_root),
            log_root: display_path(&state.runtime.log_root),
        },
        watcher,
        hourly_watcher,
        latest_candidate: read_latest_candidate(&state.runtime.evidence_root),
        prediction_testnet,
        laya,
        laya_review: read_laya_review_status(&state.runtime.evidence_root),
        supervisor: SupervisorStatus {
            resident: true,
            started_at: state.started_at,
            cadence_ms: SUPERVISOR_CADENCE_MS,
            cloud_ai_required: false,
            laya_local_only: true,
            testnet_auto_arm: false,
        },
        authority: AuthorityStatus {
            execution_enabled: testnet_demo_armed,
            testnet_demo_armed,
            mainnet_enabled: false,
            laya_execution_authority: false,
            statement: "One multi-asset TESTNET_DEMO smoke is armed for BTC, ETH, SOL, XRP, DOGE, HYPE, and BNB; Mainnet and Laya execution authority remain disabled.",
        },
    })
}

async fn fetch_laya_health(client: &reqwest::Client, endpoint: &str) -> Result<LayaHealth, String> {
    client
        .get(format!("{}/health", endpoint.trim_end_matches('/')))
        .timeout(std::time::Duration::from_secs(3))
        .send()
        .await
        .map_err(error_text)?
        .error_for_status()
        .map_err(error_text)?
        .json::<LayaHealth>()
        .await
        .map_err(error_text)
}

fn read_watcher_status(evidence_root: &Path, observed_at: u64) -> WatcherStatus {
    let scan_root = evidence_root.join("price-target-v1").join("scans");
    let latest = match fs::read_dir(&scan_root) {
        Ok(entries) => entries
            .filter_map(Result::ok)
            .filter(|entry| {
                entry.path().extension().and_then(|value| value.to_str()) == Some("json")
            })
            .filter_map(|entry| {
                let modified = entry.metadata().ok()?.modified().ok()?;
                Some((modified, entry.path()))
            })
            .max_by_key(|(modified, _)| *modified),
        Err(_) => None,
    };
    let Some((modified, path)) = latest else {
        return empty_watcher("NEVER_RUN");
    };
    let parsed: Value = match fs::read_to_string(&path)
        .ok()
        .and_then(|body| serde_json::from_str(&body).ok())
    {
        Some(value) => value,
        None => {
            return WatcherStatus {
                latest_scan_path: Some(display_path(&path)),
                ..empty_watcher("FAILED")
            }
        }
    };
    let recorded_at = parsed.get("recordedAt").and_then(Value::as_u64);
    let modified_at = modified
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .ok();
    let phase = match (recorded_at, modified_at) {
        (Some(_), Some(timestamp)) if observed_at.saturating_sub(timestamp) <= WATCHER_FRESH_MS => {
            "RUNNING"
        }
        (Some(_), Some(_)) => "STALE",
        _ => "FAILED",
    };
    let admission = parsed.get("admission").map(|value| AdmissionStatus {
        waiting: json_u64(value, "waiting"),
        qualified: json_u64(value, "qualified"),
        data_blocked: json_u64(value, "dataBlocked"),
        not_triggered: json_u64(value, "notTriggered"),
    });
    WatcherStatus {
        phase,
        process_alive: false,
        latest_cycle_at: recorded_at,
        latest_scan_path: Some(display_path(&path)),
        discovered_episodes: json_u64(&parsed, "discoveredEpisodes"),
        registered_episodes: json_u64(&parsed, "registeredEpisodes"),
        admission,
    }
}

fn read_hourly_watcher_status(evidence_root: &Path, observed_at: u64) -> HourlyWatcherStatus {
    let scan_root = evidence_root.join("up-down-v1").join("scans");
    let latest = match fs::read_dir(&scan_root) {
        Ok(entries) => entries
            .filter_map(Result::ok)
            .filter(|entry| {
                entry.path().extension().and_then(|value| value.to_str()) == Some("json")
            })
            .filter_map(|entry| {
                let modified = entry.metadata().ok()?.modified().ok()?;
                Some((modified, entry.path()))
            })
            .max_by_key(|(modified, _)| *modified),
        Err(_) => None,
    };
    let Some((modified, path)) = latest else {
        return empty_hourly_watcher("NEVER_RUN");
    };
    let parsed: Value = match fs::read_to_string(&path)
        .ok()
        .and_then(|body| serde_json::from_str(&body).ok())
    {
        Some(value) => value,
        None => {
            return HourlyWatcherStatus {
                latest_scan_path: Some(display_path(&path)),
                ..empty_hourly_watcher("FAILED")
            }
        }
    };
    let recorded_at = parsed.get("recordedAt").and_then(Value::as_u64);
    let modified_at = modified
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .ok();
    let phase = match (recorded_at, modified_at) {
        (Some(_), Some(timestamp)) if observed_at.saturating_sub(timestamp) <= WATCHER_FRESH_MS => {
            "RUNNING"
        }
        (Some(_), Some(_)) => "STALE",
        _ => "FAILED",
    };
    let admission = parsed.get("admission").map(|value| HourlyAdmissionStatus {
        waiting: json_u64(value, "waiting"),
        qualified: json_u64(value, "qualified"),
        data_blocked: json_u64(value, "dataBlocked"),
        expired: json_u64(value, "expired"),
    });
    HourlyWatcherStatus {
        phase,
        process_alive: false,
        latest_cycle_at: recorded_at,
        latest_scan_path: Some(display_path(&path)),
        monitored_assets: parsed
            .get("monitoredAssets")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default(),
        market_supplied_assets: parsed
            .get("marketSuppliedAssets")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default(),
        discovered_episodes: json_u64(&parsed, "discoveredEpisodes"),
        active_episodes: json_u64(&parsed, "activeEpisodes"),
        admission,
    }
}

fn read_prediction_testnet_status(state_root: &Path) -> PredictionTestnetStatus {
    let path = state_root.join("prediction-testnet-demo-status.json");
    let Some(parsed) = fs::read_to_string(&path)
        .ok()
        .and_then(|body| serde_json::from_str::<Value>(&body).ok())
    else {
        return PredictionTestnetStatus {
            phase: "DISARMED".into(),
            process_alive: false,
            updated_at: None,
            armed_at: None,
            allowed_assets: Vec::new(),
            candidate_id: None,
            venue_symbol: None,
            evidence_path: None,
            detail: None,
        };
    };
    PredictionTestnetStatus {
        phase: parsed
            .get("phase")
            .and_then(Value::as_str)
            .unwrap_or("FAILED_REVIEW_REQUIRED")
            .to_owned(),
        process_alive: false,
        updated_at: parsed.get("updatedAt").and_then(Value::as_u64),
        armed_at: parsed.get("armedAt").and_then(Value::as_u64),
        allowed_assets: parsed
            .get("allowedAssets")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default(),
        candidate_id: json_string(&parsed, "candidateId"),
        venue_symbol: json_string(&parsed, "venueSymbol"),
        evidence_path: json_string(&parsed, "evidencePath"),
        detail: json_string(&parsed, "detail"),
    }
}

fn read_latest_candidate(evidence_root: &Path) -> Option<CandidateStatus> {
    match (
        read_latest_price_target_candidate(evidence_root),
        read_latest_hourly_candidate(evidence_root),
    ) {
        (Some(price), Some(hourly)) => {
            if hourly.candidate_t0 > price.candidate_t0 {
                Some(hourly)
            } else {
                Some(price)
            }
        }
        (Some(candidate), None) | (None, Some(candidate)) => Some(candidate),
        (None, None) => None,
    }
}

fn read_latest_price_target_candidate(evidence_root: &Path) -> Option<CandidateStatus> {
    let states_root = evidence_root.join("price-target-v1").join("states");
    let mut selected: Option<(u64, Value)> = None;
    for entry in fs::read_dir(states_root).ok()?.filter_map(Result::ok) {
        if entry.path().extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let Some(parsed) = fs::read_to_string(entry.path())
            .ok()
            .and_then(|body| serde_json::from_str::<Value>(&body).ok())
        else {
            continue;
        };
        if parsed.get("status").and_then(Value::as_str) != Some("QUALIFIED") {
            continue;
        }
        let candidate = parsed.get("candidate")?;
        let candidate_t0 = candidate.get("candidateT0").and_then(Value::as_u64)?;
        if selected
            .as_ref()
            .map(|(current, _)| candidate_t0 > *current)
            .unwrap_or(true)
        {
            selected = Some((candidate_t0, parsed));
        }
    }
    let (candidate_t0, state) = selected?;
    let manifest_id = state.get("manifestId").and_then(Value::as_str)?;
    let manifest_path = evidence_root
        .join("price-target-v1")
        .join("manifests")
        .join(format!("{manifest_id}.json"));
    let manifest: Value = serde_json::from_str(&fs::read_to_string(manifest_path).ok()?).ok()?;
    let candidate = state.get("candidate")?;
    let episode = manifest.get("episode")?;
    let owner_event = manifest.get("ownerEvent")?;
    let registration = manifest.get("registration")?;
    Some(CandidateStatus {
        variant: "PRICE_TARGET_V1".into(),
        candidate_id: json_string(candidate, "candidateId")?,
        asset: json_string(episode, "asset")?,
        direction: Some("UP".into()),
        question: json_string(registration, "selectedQuestion")?,
        event_title: json_string(owner_event, "title")?,
        candidate_t0,
        measurement_at: episode.get("measurementAt").and_then(Value::as_u64)?,
        selected_strike: Some(json_f64(candidate, "selectedStrike")?),
        reference_open: None,
        crossing_previous_close: json_f64(candidate, "crossingPreviousClose")?,
        crossing_close: json_f64(candidate, "crossingClose")?,
        entry_best_ask: json_f64(candidate, "entryBestAsk")?,
        entry_best_ask_size: json_f64(candidate, "entryBestAskSize")?,
    })
}

fn read_latest_hourly_candidate(evidence_root: &Path) -> Option<CandidateStatus> {
    let states_root = evidence_root.join("up-down-v1").join("states");
    let mut selected: Option<(u64, Value)> = None;
    for entry in fs::read_dir(states_root).ok()?.filter_map(Result::ok) {
        if entry.path().extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let Some(parsed) = fs::read_to_string(entry.path())
            .ok()
            .and_then(|body| serde_json::from_str::<Value>(&body).ok())
        else {
            continue;
        };
        if parsed.get("status").and_then(Value::as_str) != Some("QUALIFIED") {
            continue;
        }
        let candidate = parsed.get("candidate")?;
        let candidate_t0 = candidate.get("candidateT0").and_then(Value::as_u64)?;
        if selected
            .as_ref()
            .map(|(current, _)| candidate_t0 > *current)
            .unwrap_or(true)
        {
            selected = Some((candidate_t0, candidate.clone()));
        }
    }
    let (candidate_t0, candidate) = selected?;
    Some(CandidateStatus {
        variant: json_string(&candidate, "variant")?,
        candidate_id: json_string(&candidate, "candidateId")?,
        asset: json_string(&candidate, "asset")?,
        direction: json_string(&candidate, "direction"),
        question: json_string(&candidate, "question")?,
        event_title: json_string(&candidate, "eventTitle")?,
        candidate_t0,
        measurement_at: candidate.get("measurementAt").and_then(Value::as_u64)?,
        selected_strike: None,
        reference_open: Some(json_f64(&candidate, "referenceOpen")?),
        crossing_previous_close: json_f64(&candidate, "crossingPreviousClose")?,
        crossing_close: json_f64(&candidate, "crossingClose")?,
        entry_best_ask: json_f64(&candidate, "entryBestAsk")?,
        entry_best_ask_size: json_f64(&candidate, "entryBestAskSize")?,
    })
}

fn read_laya_review_status(evidence_root: &Path) -> LayaReviewStatus {
    let reviews_root = evidence_root
        .join("price-target-v1")
        .join("laya-shadow-v1")
        .join("reviews");
    let latest = match fs::read_dir(&reviews_root) {
        Ok(entries) => entries
            .filter_map(Result::ok)
            .filter(|entry| {
                entry.path().extension().and_then(|value| value.to_str()) == Some("json")
            })
            .filter_map(|entry| {
                let modified = entry.metadata().ok()?.modified().ok()?;
                Some((modified, entry.path()))
            })
            .max_by_key(|(modified, _)| *modified),
        Err(_) => None,
    };
    let Some((_modified, path)) = latest else {
        return empty_laya_review("NO_REVIEW", None);
    };
    let parsed: Value = match fs::read_to_string(&path)
        .ok()
        .and_then(|body| serde_json::from_str(&body).ok())
    {
        Some(value) => value,
        None => {
            return empty_laya_review(
                "FAILED",
                Some(format!(
                    "review artifact is unreadable: {}",
                    display_path(&path)
                )),
            )
        }
    };
    let result = parsed.get("result").unwrap_or(&Value::Null);
    LayaReviewStatus {
        phase: "COMPLETED",
        reviewed_at: parsed.get("reviewedAt").and_then(Value::as_u64),
        candidate_id: json_string(&parsed, "candidateId"),
        choice: json_string(result, "choice"),
        confidence: result.get("confidence").and_then(Value::as_f64),
        answer_confidence: result.get("answerConfidence").and_then(Value::as_f64),
        inference_ms: result.get("inferenceMs").and_then(Value::as_f64),
        model: json_string(result, "routedModel"),
        artifact_path: Some(display_path(&path)),
        detail: None,
    }
}

fn empty_laya_review(phase: &'static str, detail: Option<String>) -> LayaReviewStatus {
    LayaReviewStatus {
        phase,
        reviewed_at: None,
        candidate_id: None,
        choice: None,
        confidence: None,
        answer_confidence: None,
        inference_ms: None,
        model: None,
        artifact_path: None,
        detail,
    }
}

fn empty_watcher(phase: &'static str) -> WatcherStatus {
    WatcherStatus {
        phase,
        process_alive: false,
        latest_cycle_at: None,
        latest_scan_path: None,
        discovered_episodes: 0,
        registered_episodes: 0,
        admission: None,
    }
}

fn empty_hourly_watcher(phase: &'static str) -> HourlyWatcherStatus {
    HourlyWatcherStatus {
        phase,
        process_alive: false,
        latest_cycle_at: None,
        latest_scan_path: None,
        monitored_assets: Vec::new(),
        market_supplied_assets: Vec::new(),
        discovered_episodes: 0,
        active_episodes: 0,
        admission: None,
    }
}

fn json_u64(value: &Value, key: &str) -> u64 {
    value.get(key).and_then(Value::as_u64).unwrap_or(0)
}

fn json_string(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn json_f64(value: &Value, key: &str) -> Option<f64> {
    value.get(key).and_then(Value::as_f64)
}

fn runtime_paths(app: &AppHandle, workspace_root: &Path) -> Result<RuntimePaths, String> {
    if let Ok(configured) = env::var("PREPERP_DATA_ROOT") {
        if !configured.trim().is_empty() {
            let data_root = PathBuf::from(configured);
            return Ok(packaged_paths(data_root));
        }
    }
    if workspace_root
        .join("src")
        .join("overlay")
        .join("price-target-collector.ts")
        .is_file()
    {
        return Ok(RuntimePaths {
            mode: if cfg!(debug_assertions) {
                "DEVELOPMENT"
            } else {
                "LOCAL_WORKSPACE"
            },
            data_root: workspace_root.to_path_buf(),
            evidence_root: workspace_root.join("work"),
            state_root: workspace_root.join(".runtime"),
            log_root: workspace_root.join(".runtime").join("logs"),
        });
    }
    let data_root = app.path().app_data_dir().map_err(error_text)?;
    Ok(packaged_paths(data_root))
}

fn packaged_paths(data_root: PathBuf) -> RuntimePaths {
    RuntimePaths {
        mode: "PACKAGED",
        evidence_root: data_root.join("work"),
        state_root: data_root.join("state"),
        log_root: data_root.join("logs"),
        data_root,
    }
}

fn workspace_root() -> PathBuf {
    let path = env::var_os("PREPERP_WORKSPACE_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("..")
        });
    path.canonicalize().unwrap_or(path)
}

fn laya_root(workspace_root: &Path) -> PathBuf {
    env::var_os("LAYA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            workspace_root
                .parent()
                .unwrap_or(workspace_root)
                .join("laya-sidecar")
        })
}

fn is_loopback_endpoint(endpoint: &str) -> bool {
    endpoint.starts_with("http://127.0.0.1:") || endpoint.starts_with("http://localhost:")
}

fn display_path(path: &Path) -> String {
    let value = path.to_string_lossy();
    value.strip_prefix(r"\\?\").unwrap_or(&value).to_string()
}

fn now_ms() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .map_err(error_text)
}

fn error_text(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn start_runtime_supervisor(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut first_cycle = true;
        loop {
            let state = app.state::<AppState>();
            let log_root = state.runtime.log_root.clone();
            let laya = ensure_laya_inner(state.inner()).await;
            let watcher = ensure_watcher_inner(state.inner()).await;
            drop(state);

            if first_cycle || laya.is_err() || watcher.is_err() {
                append_supervisor_log(
                    &log_root,
                    &format!(
                        "laya={} watcher={} testnet_auto_arm=false",
                        result_label(&laya),
                        result_label(&watcher)
                    ),
                );
            }
            first_cycle = false;
            tokio::time::sleep(Duration::from_millis(SUPERVISOR_CADENCE_MS)).await;
        }
    });
}

fn result_label(result: &Result<(), String>) -> String {
    match result {
        Ok(()) => "ok".into(),
        Err(error) => format!("error:{error}"),
    }
}

fn append_supervisor_log(log_root: &Path, message: &str) {
    if fs::create_dir_all(log_root).is_err() {
        return;
    }
    let Ok(timestamp) = now_ms() else {
        return;
    };
    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_root.join("desktop-supervisor.log"))
    {
        let _ = writeln!(file, "{timestamp} {message}");
    }
}

fn stop_owned_children(state: &AppState) {
    stop_owned_child(&state.testnet_child);
    stop_owned_child(&state.watcher_child);
    stop_owned_child(&state.laya_child);
}

fn stop_owned_child(slot: &Mutex<Option<Child>>) {
    let Ok(mut guard) = slot.lock() else {
        return;
    };
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn setup_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "打开 PrePerp 控制台", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出并停止本地采集", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let mut tray = TrayIconBuilder::with_id("preperp-runtime")
        .tooltip("PrePerp 本地量化运行时")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main_window(app),
            "quit" => {
                let state = app.state::<AppState>();
                stop_owned_children(state.inner());
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--background"]),
        ))
        .setup(|app| {
            let workspace_root = workspace_root();
            let runtime = runtime_paths(&app.handle(), &workspace_root)?;
            fs::create_dir_all(&runtime.state_root).map_err(error_text)?;
            fs::create_dir_all(&runtime.log_root).map_err(error_text)?;
            let laya_endpoint =
                env::var("LAYA_BASE_URL").unwrap_or_else(|_| LAYA_DEFAULT_ENDPOINT.into());
            app.manage(AppState {
                runtime,
                workspace_root,
                laya_endpoint,
                laya_child: Mutex::new(None),
                watcher_child: Mutex::new(None),
                testnet_child: Mutex::new(None),
                client: reqwest::Client::new(),
                started_at: now_ms()?,
            });
            setup_tray(app).map_err(error_text)?;
            if env::args().any(|argument| argument == "--background") {
                if let Some(window) = app.get_webview_window("main") {
                    window.hide().map_err(error_text)?;
                }
            }
            start_runtime_supervisor(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            ensure_laya,
            ensure_watcher,
            ensure_prediction_testnet,
            system_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running PrePerp Control Room");
}
