//! tweet-fetch CLI：用真实 X 链接抓取推文并输出与 TweetInfo 契约一致的 JSON。

use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

use xgif_tweet_fetch::{
    fetch_tweet_with_report, Endpoint, FetchOptions, ProxyMode, ProxySettings, DEFAULT_BYPASS,
    DEFAULT_TIMEOUT_MS, DEFAULT_USER_AGENT,
};

const USAGE: &str = r#"tweet-fetch —— X 媒体工坊真实推文解析原型（移植 electron/lib/tweet.cjs）

用法:
  tweet-fetch <推文链接> [选项]

选项:
  --proxy <url>          自定义代理，支持 http:// / https:// / socks5:// 或裸 host:port
  --proxy-mode <mode>    system | custom | direct（默认 system；给出 --proxy 时默认 custom）
  --proxy-user <name>    代理认证用户名
  --proxy-pass <pass>    代理认证密码
  --proxy-bypass <list>  不走代理的主机，分号/逗号/空格分隔（默认 localhost;127.0.0.1;<local>）
  --timeout-ms <n>       单个接口超时毫秒数（默认 15000）
  --only <labels>        只尝试指定接口，逗号分隔：fxtwitter,fxtwitter-v1,syndication,vxtwitter
  --output <path>        同时把 JSON 写入文件（UTF-8，无 BOM）
  --compact              输出紧凑 JSON
  -v, --verbose          在 stderr 输出回退尝试过程
  -h, --help             显示本帮助

示例:
  tweet-fetch https://x.com/user/status/1234567890
  tweet-fetch https://x.com/user/status/1234567890 --proxy http://127.0.0.1:7890
  tweet-fetch https://x.com/user/status/1234567890 --only syndication --verbose
  tweet-fetch https://x.com/user/status/1234567890 --output out/tweet.json

退出码: 0 成功；1 参数错误；2 抓取失败；3 写输出文件失败。
"#;

#[derive(Debug, Default)]
struct CliArgs {
    url: String,
    proxy: String,
    proxy_mode: Option<String>,
    proxy_user: String,
    proxy_pass: String,
    proxy_bypass: Option<String>,
    timeout_ms: Option<u64>,
    only: Option<String>,
    output: Option<PathBuf>,
    compact: bool,
    verbose: bool,
    help: bool,
}

fn parse_args() -> Result<CliArgs, String> {
    let args: Vec<String> = std::env::args().collect();
    let mut parsed = CliArgs::default();
    let mut index = 1;
    while index < args.len() {
        let argument = args[index].clone();
        let (flag, inline_value) = match argument.split_once('=') {
            Some((flag, value)) => (flag.to_string(), Some(value.to_string())),
            None => (argument.clone(), None),
        };
        let take_value = |flag: &str, index: &mut usize| -> Result<String, String> {
            if let Some(value) = inline_value.clone() {
                return Ok(value);
            }
            *index += 1;
            args.get(*index)
                .cloned()
                .ok_or_else(|| format!("参数 {} 缺少值", flag))
        };
        match flag.as_str() {
            "-h" | "--help" => parsed.help = true,
            "--compact" => parsed.compact = true,
            "-v" | "--verbose" => parsed.verbose = true,
            "--proxy" => parsed.proxy = take_value("--proxy", &mut index)?,
            "--proxy-mode" => parsed.proxy_mode = Some(take_value("--proxy-mode", &mut index)?),
            "--proxy-user" => parsed.proxy_user = take_value("--proxy-user", &mut index)?,
            "--proxy-pass" => parsed.proxy_pass = take_value("--proxy-pass", &mut index)?,
            "--proxy-bypass" => {
                parsed.proxy_bypass = Some(take_value("--proxy-bypass", &mut index)?)
            }
            "--timeout-ms" => {
                let value = take_value("--timeout-ms", &mut index)?;
                parsed.timeout_ms = Some(
                    value
                        .parse::<u64>()
                        .map_err(|_| format!("--timeout-ms 不是合法整数：{}", value))?,
                );
            }
            "--only" => parsed.only = Some(take_value("--only", &mut index)?),
            "--output" => parsed.output = Some(PathBuf::from(take_value("--output", &mut index)?)),
            other => {
                if other.starts_with('-') {
                    return Err(format!("未知参数：{}", other));
                }
                if parsed.url.is_empty() {
                    parsed.url = argument;
                } else {
                    return Err(format!("只接受一个推文链接，多余参数：{}", other));
                }
            }
        }
        index += 1;
    }
    Ok(parsed)
}

fn main() -> ExitCode {
    let args = match parse_args() {
        Ok(args) => args,
        Err(message) => {
            eprintln!("参数错误：{}", message);
            eprintln!();
            eprint!("{}", USAGE);
            return ExitCode::from(1);
        }
    };
    if args.help || args.url.is_empty() {
        eprint!("{}", USAGE);
        return ExitCode::from(if args.help { 0 } else { 1 });
    }

    let mode = match &args.proxy_mode {
        Some(mode) => match ProxyMode::from_str(mode) {
            Some(mode) => mode,
            None => {
                eprintln!(
                    "--proxy-mode 只支持 system / custom / direct，收到：{}",
                    mode
                );
                return ExitCode::from(1);
            }
        },
        None => {
            if args.proxy.trim().is_empty() {
                ProxyMode::System
            } else {
                ProxyMode::Custom
            }
        }
    };

    let endpoints = match &args.only {
        Some(labels) => {
            let mut parsed_endpoints: Vec<Endpoint> = Vec::new();
            for label in labels.split(',') {
                let label = label.trim();
                if label.is_empty() {
                    continue;
                }
                match Endpoint::from_label(label) {
                    Some(endpoint) => parsed_endpoints.push(endpoint),
                    None => {
                        eprintln!("--only 不支持接口：{}", label);
                        return ExitCode::from(1);
                    }
                }
            }
            if parsed_endpoints.is_empty() {
                eprintln!("--only 需要至少一个接口名");
                return ExitCode::from(1);
            }
            Some(parsed_endpoints)
        }
        None => None,
    };

    let proxy = ProxySettings {
        mode,
        url: args.proxy.clone(),
        bypass: args
            .proxy_bypass
            .clone()
            .unwrap_or_else(|| DEFAULT_BYPASS.to_string()),
        username: args.proxy_user.clone(),
        password: args.proxy_pass.clone(),
    }
    .normalized();

    let options = FetchOptions {
        proxy,
        timeout: Duration::from_millis(args.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS)),
        user_agent: DEFAULT_USER_AGENT.to_string(),
        endpoints,
    };

    match fetch_tweet_with_report(&args.url, &options) {
        Ok(report) => {
            if args.verbose {
                for attempt in &report.attempts {
                    match &attempt.message {
                        Some(message) => {
                            eprintln!("[尝试] {:<13} 失败：{}", attempt.endpoint.label(), message)
                        }
                        None => {
                            eprintln!("[尝试] {:<13} 成功（已取得媒体）", attempt.endpoint.label())
                        }
                    }
                }
                eprintln!("[完成] 数据来源：{}", report.endpoint.label());
            }
            let json = if args.compact {
                serde_json::to_string(&report.info)
            } else {
                serde_json::to_string_pretty(&report.info)
            };
            let json = match json {
                Ok(json) => json,
                Err(error) => {
                    eprintln!("序列化推文 JSON 失败：{}", error);
                    return ExitCode::from(2);
                }
            };
            if let Some(path) = &args.output {
                if let Some(parent) = path
                    .parent()
                    .filter(|parent| !parent.as_os_str().is_empty())
                {
                    if let Err(error) = std::fs::create_dir_all(parent) {
                        eprintln!("创建输出目录失败：{}", error);
                        return ExitCode::from(3);
                    }
                }
                if let Err(error) = std::fs::write(path, format!("{}\n", json)) {
                    eprintln!("写入输出文件失败：{}", error);
                    return ExitCode::from(3);
                }
                eprintln!("[输出] {}", path.display());
            }
            println!("{}", json);
            ExitCode::SUCCESS
        }
        Err(error) => {
            let payload = serde_json::json!({
                "ok": false,
                "error": {
                    "code": error.code.as_str(),
                    "message": error.message,
                }
            });
            println!(
                "{}",
                serde_json::to_string_pretty(&payload).unwrap_or_default()
            );
            eprintln!("抓取失败（{}）：{}", error.code.as_str(), error.message);
            ExitCode::from(2)
        }
    }
}
