//! A minimal SMTP client: enough to deliver one plain-text alert through the
//! relay an operator already has.
//!
//! Hand-written rather than a crate, for the size of the subset. An alert is one
//! short text message to one or a few addresses, so what is needed is submission
//! with `AUTH PLAIN` or `AUTH LOGIN` over implicit TLS (465), STARTTLS (587) or
//! nothing at all (a relay on the hub's own host). A general-purpose mail crate
//! brings HTML bodies, attachments, DKIM and OAuth2 -- each of them weight in a
//! binary that has to fit in 256 MB -- and none of them is something an alert
//! needs.
//!
//! The dialogue is written against a generic stream, so the tests drive it over
//! `tokio::io::duplex` against a fake server that asserts every line it is sent:
//! no network, no certificate, and the wire format is checked as bytes.
//!
//! What is deliberately not here: pipelining (one command, one reply, which is
//! what every relay expects of a client that sends a handful of messages a day),
//! connection reuse (an alert is rare, and a pooled session would have to be
//! re-established after every idle timeout anyway), and `AUTH XOAUTH2`, which
//! Gmail and Microsoft 365 want for their modern authentication. Those two are
//! reached with an app password and a relay respectively.

use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;

/// How long any one line of the dialogue may take. The connection itself, the TLS
/// handshake and every reply are each bounded by it, and the caller adds a budget
/// for the whole message on top.
const STEP: Duration = Duration::from_secs(10);

/// The most a server may answer with in one reply. A greeting with a long
/// EHLO list is under 2 KB; this only keeps a server that never ends a line from
/// growing the buffer without bound.
const MAX_REPLY: usize = 16 * 1024;

/// How the connection is protected. Chosen explicitly rather than negotiated: a
/// server that does not advertise STARTTLS would otherwise be talked to in the
/// clear, with the password in the first thing that crosses it.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Security {
    /// Implicit TLS, the whole session encrypted: port 465.
    Tls,
    /// Connect in the clear, then upgrade before anything secret is sent: 587.
    StartTls,
    /// Nothing, for a relay on the hub's own host or network.
    Plain,
}

impl Security {
    /// The stored name of one, or `None` where the value is not one of them.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "tls" => Some(Self::Tls),
            "starttls" => Some(Self::StartTls),
            "none" => Some(Self::Plain),
            _ => None,
        }
    }

    /// What the setting holds, which is also what the panel shows.
    pub fn name(self) -> &'static str {
        match self {
            Self::Tls => "tls",
            Self::StartTls => "starttls",
            Self::Plain => "none",
        }
    }

    /// The port this protection is usually on, for a card that has not been given
    /// one: implicit TLS is 465 and STARTTLS is 587 by convention, and swapping
    /// them is the most common way this fails.
    pub fn default_port(self) -> u16 {
        match self {
            Self::Tls => 465,
            Self::StartTls => 587,
            Self::Plain => 25,
        }
    }
}

/// Where to deliver, as the panel's card holds it.
#[derive(Clone, Debug)]
pub struct Server {
    pub host: String,
    pub port: u16,
    pub security: Security,
    /// Empty for a relay that takes no credentials.
    pub user: String,
    pub password: String,
}

/// One message: who it is from, who it is for, and the two texts that are rendered
/// from the alert's own templates.
#[derive(Clone, Debug)]
pub struct Message {
    pub from: String,
    pub to: Vec<String>,
    pub subject: String,
    pub body: String,
}

/// Why a delivery failed, and whether another attempt could change that.
///
/// The same shape as `notify::Failure`, which is where it ends up: `shown` is what
/// the panel says, composed here from what failed and the code, and `reason` is
/// the server's own words, for the log. They are kept apart because a relay's text
/// often quotes the address, the sender or the rejected header -- the panel shows
/// no part of it.
#[derive(Debug)]
pub struct Failed {
    pub retry: bool,
    pub reason: String,
    pub shown: String,
}

impl Failed {
    fn new(retry: bool, shown: impl Into<String>, reason: impl Into<String>) -> Self {
        Self { retry, shown: shown.into(), reason: reason.into() }
    }

    /// A failure that no retry changes, and that the operator can act on.
    fn fixed(shown: impl Into<String>, reason: impl Into<String>) -> Self {
        Self::new(false, shown, reason)
    }
}

/// Which part of the conversation a reply answered, so a refusal can be explained
/// in the terms of the card the operator is looking at.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Step {
    Greeting,
    Ehlo,
    StartTls,
    Auth,
    Mail,
    Rcpt,
    Data,
    Body,
}

impl Step {
    fn what(self) -> &'static str {
        match self {
            Self::Greeting => "the greeting",
            Self::Ehlo => "EHLO",
            Self::StartTls => "STARTTLS",
            Self::Auth => "the sign-in",
            Self::Mail => "the sender",
            Self::Rcpt => "the recipient",
            Self::Data => "DATA",
            Self::Body => "the message",
        }
    }
}

/// Delivers one message, or says why not.
pub async fn send(server: &Server, message: &Message) -> Result<(), Failed> {
    let stream = tokio::time::timeout(STEP, TcpStream::connect((server.host.as_str(), server.port)))
        .await
        .map_err(|_| Failed::new(true, "连不上邮件服务器：连接超时", "connect timed out"))?
        .map_err(|e| {
            Failed::new(true, format!("连不上邮件服务器（{}:{}）", server.host, server.port), format!("{e}"))
        })?;
    match server.security {
        Security::Tls => {
            let tls = upgrade(stream, &server.host).await?;
            session(tls, server, message, false).await
        }
        Security::StartTls => {
            // Greeted in the clear, but not told anything: the only exchange before
            // the upgrade is EHLO, and the server resets its state at STARTTLS, so
            // the session below starts with EHLO again and no greeting.
            let mut conn = Conn::new(stream);
            expect(&mut conn, Step::Greeting, &[220]).await?;
            let caps = ehlo(&mut conn, Step::Ehlo).await?;
            if !caps.iter().any(|line| first_word(line).eq_ignore_ascii_case("STARTTLS")) {
                return Err(Failed::fixed(
                    "服务器没有提供 STARTTLS。要明文发送就改选「不加密」，或者把加密方式换成 465 的 tls",
                    "STARTTLS was not offered",
                ));
            }
            expect(&mut conn, Step::StartTls, &[220]).await?;
            let stream = conn.into_inner()?;
            let tls = upgrade(stream, &server.host).await?;
            session(tls, server, message, true).await
        }
        Security::Plain => session(stream, server, message, false).await,
    }
}

/// Everything from EHLO to QUIT, on a stream that is already as protected as it
/// will get. `greeted` is false where the connection has not been greeted yet --
/// which is every path but STARTTLS, whose upgrade happens mid-session.
async fn session<S>(stream: S, server: &Server, message: &Message, greeted: bool) -> Result<(), Failed>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let mut conn = Conn::new(stream);
    if !greeted {
        expect(&mut conn, Step::Greeting, &[220]).await?;
    }
    let caps = ehlo(&mut conn, Step::Ehlo).await?;
    authenticate(&mut conn, server, &caps).await?;
    deliver(&mut conn, message).await?;
    // Best effort: the message is delivered, and a QUIT nobody answered costs
    // nothing. The socket closes on drop either way.
    let _ = conn.cmd("QUIT").await;
    Ok(())
}

async fn ehlo<S>(conn: &mut Conn<S>, step: Step) -> Result<Vec<String>, Failed>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let (code, text) = conn.cmd(&format!("EHLO {}", helo_name())).await?;
    if code != 250 {
        return Err(refused(step, code, &text));
    }
    // The first line names the server; the rest are its extensions.
    Ok(text.lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_owned).collect())
}

/// Signs in when the relay both offers a mechanism and was given a password.
///
/// A server that advertises neither is taken at its word: a relay on the hub's own
/// network commonly authenticates by address. A server that advertises only a
/// mechanism this client does not speak is an error rather than a silent
/// unauthenticated attempt, which would be refused further down with a message
/// about the sender.
async fn authenticate<S>(conn: &mut Conn<S>, server: &Server, caps: &[String]) -> Result<(), Failed>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let mechanisms: Vec<String> = caps
        .iter()
        .filter(|line| first_word(line).eq_ignore_ascii_case("AUTH"))
        .flat_map(|line| line.split_whitespace().skip(1).map(|m| m.to_ascii_uppercase()))
        .collect();
    if server.user.is_empty() || mechanisms.is_empty() {
        return Ok(());
    }
    let b64 = |text: &str| base64::engine::general_purpose::STANDARD.encode(text.as_bytes());
    if mechanisms.iter().any(|m| m == "PLAIN") {
        // One round trip: the authorization identity is empty, which every relay
        // accepts when it equals the authentication identity.
        let token = b64(&format!("\0{}\0{}", server.user, server.password));
        return command(conn, Step::Auth, &[235], &format!("AUTH PLAIN {token}")).await;
    }
    if mechanisms.iter().any(|m| m == "LOGIN") {
        command(conn, Step::Auth, &[334], "AUTH LOGIN").await?;
        command(conn, Step::Auth, &[334], &b64(&server.user)).await?;
        return command(conn, Step::Auth, &[235], &b64(&server.password)).await;
    }
    Err(Failed::fixed(
        format!("服务器要求 {}，本面板只支持 PLAIN 和 LOGIN 两种登录方式", mechanisms.join("/")),
        format!("unsupported AUTH mechanisms: {}", mechanisms.join(",")),
    ))
}

async fn deliver<S>(conn: &mut Conn<S>, message: &Message) -> Result<(), Failed>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let (code, text) = conn.cmd(&format!("MAIL FROM:<{}>", message.from)).await?;
    if code != 250 {
        return Err(refused(Step::Mail, code, &text));
    }
    // Accepted for delivery rather than rejected: 250 and 251 (forwarded) are the
    // two a relay answers with.
    for to in &message.to {
        let (code, text) = conn.cmd(&format!("RCPT TO:<{to}>")).await?;
        if !matches!(code, 250 | 251) {
            return Err(refused(Step::Rcpt, code, &text));
        }
    }
    command(conn, Step::Data, &[354], "DATA").await?;
    write_line(conn, &stuffed(&message.render())).await?;
    // The end of the payload is a line holding one dot, which dot-stuffing has
    // made sure nothing inside it can be mistaken for.
    write_line(conn, ".").await?;
    expect(conn, Step::Body, &[250]).await
}

impl Message {
    /// The DATA payload: headers, then the body in base64, CRLF line endings and
    /// no terminating dot (see `deliver`).
    ///
    /// Base64 rather than quoted-printable because it is one call, it leaves the
    /// payload independent of the transfer's line-length rules, and no line it
    /// produces can begin with a dot. The headers are still sent as text: they are
    /// ASCII, and a "Subject:" a person can read in a raw dump is worth more than
    /// uniformity.
    fn render(&self) -> String {
        let mut out = String::with_capacity(512 + self.body.len() * 4 / 3);
        out.push_str(&format!("From: {}\r\n", self.from));
        out.push_str(&format!("To: {}\r\n", self.to.join(", ")));
        out.push_str(&format!("Subject: {}\r\n", encode_header(&self.subject)));
        out.push_str(&format!("Date: {}\r\n", chrono::Utc::now().to_rfc2822()));
        out.push_str(&format!("Message-ID: {}\r\n", message_id(&self.from)));
        out.push_str("MIME-Version: 1.0\r\n");
        out.push_str("Content-Type: text/plain; charset=utf-8\r\n");
        out.push_str("Content-Transfer-Encoding: base64\r\n");
        out.push_str("\r\n");
        let encoded = base64::engine::general_purpose::STANDARD.encode(self.body.as_bytes());
        for line in encoded.as_bytes().chunks(76) {
            out.push_str(std::str::from_utf8(line).unwrap_or_default());
            out.push_str("\r\n");
        }
        out
    }
}

/// A header value that may hold anything: ASCII goes through as it is, and
/// non-ASCII is encoded as RFC 2047 words, split on character boundaries so that
/// each word holds at most 45 bytes -- 60 base64 characters, inside the 75 a
/// header line may carry. Several words in one header are folded with a space,
/// which is what a reader drops when it joins them back.
fn encode_header(value: &str) -> String {
    if value.is_ascii() {
        return value.to_owned();
    }
    let engine = base64::engine::general_purpose::STANDARD;
    let mut words = Vec::new();
    let mut chunk = String::new();
    for ch in value.chars() {
        if !chunk.is_empty() && chunk.len() + ch.len_utf8() > 45 {
            words.push(format!("=?UTF-8?B?{}?=", engine.encode(chunk.as_bytes())));
            chunk.clear();
        }
        chunk.push(ch);
    }
    if !chunk.is_empty() {
        words.push(format!("=?UTF-8?B?{}?=", engine.encode(chunk.as_bytes())));
    }
    words.join("\r\n ")
}

/// A Message-ID whose right-hand side is the sender's own domain: the header is
/// only required to be globally unique, and putting the sending domain in it is
/// what keeps the field meaningful to the receiving side.
fn message_id(from: &str) -> String {
    let domain = from.rsplit('<').next().unwrap_or(from).split('@').nth(1).unwrap_or_default();
    let domain = domain.trim_end_matches('>').trim_end_matches('.').trim();
    let domain = if domain.is_empty() { "probe-hub.local" } else { domain };
    format!("<{}.{:016x}@{}>", chrono::Utc::now().timestamp(), rand::random::<u64>(), domain)
}

/// The name this client announces. A real hostname where the process can read
/// one (a container reports its own id), since a relay that checks HELO against
/// the connecting address has something to check, and a fixed `probe-hub` would
/// give it nothing.
fn helo_name() -> String {
    for path in ["/proc/sys/kernel/hostname", "/etc/hostname"] {
        if let Ok(name) = std::fs::read_to_string(path) {
            let name: String = name.trim().chars().filter(|c| !c.is_whitespace()).collect();
            if !name.is_empty() && name.is_ascii() {
                return name;
            }
        }
    }
    "localhost".to_owned()
}

/// Doubles a dot at the start of any line, so that a body line holding one dot
/// cannot end the message. Nothing this client sends can produce one -- base64 has
/// no dots -- which is exactly why it is done here, where a future plain-text body
/// would otherwise have to remember.
fn stuffed(payload: &str) -> String {
    let mut out = String::with_capacity(payload.len());
    let mut at_line_start = true;
    for ch in payload.chars() {
        if at_line_start && ch == '.' {
            out.push('.');
        }
        out.push(ch);
        at_line_start = ch == '\n';
    }
    out
}

fn first_word(line: &str) -> &str {
    line.split_whitespace().next().unwrap_or_default()
}

/// The connection, and the one thing that needs remembering about it: whether a
/// reply's line ended with a space or a dash, which is how SMTP says "more lines
/// follow".
struct Conn<S> {
    io: BufReader<S>,
}

impl<S> Conn<S>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    fn new(io: S) -> Self {
        Self { io: BufReader::new(io) }
    }

    /// One reply: every line of it, and its code.
    async fn reply(&mut self) -> Result<(u16, String), Failed> {
        let mut text = String::new();
        let mut code = 0;
        loop {
            let mut line = String::new();
            let read = tokio::time::timeout(STEP, self.io.read_line(&mut line)).await;
            match read {
                Ok(Ok(0)) => {
                    return Err(Failed::new(true, "对方断开了连接，没有回复", "the connection closed"));
                }
                Ok(Ok(_)) => {}
                Ok(Err(e)) => {
                    return Err(Failed::new(true, "读不到服务器回复", format!("{e}")));
                }
                Err(_) => {
                    return Err(Failed::new(true, "邮件服务器没有在 10 秒内回复", "reply timed out"));
                }
            }
            if text.len() + line.len() > MAX_REPLY {
                return Err(Failed::fixed(
                    "服务器的回复过长，可能不是邮件服务",
                    format!("reply longer than {MAX_REPLY} bytes"),
                ));
            }
            let line = line.trim_end_matches(['\r', '\n']);
            // `250-text` continues, `250 text` ends. Anything that is not three
            // digits is not a reply at all: a port that answers TLS or HTTP gives
            // this client text it cannot read, and saying so beats a timeout.
            let this = match line.get(..3).and_then(|c| c.parse::<u16>().ok()) {
                Some(code) if line.len() == 3 || line.as_bytes()[3] == b'-' || line.as_bytes()[3] == b' ' => {
                    code
                }
                _ => {
                    return Err(Failed::fixed(
                        "对方不是邮件服务：检查端口与加密方式是否对应",
                        format!("not an SMTP reply: {:?}", line.chars().take(120).collect::<String>()),
                    ));
                }
            };
            if code != 0 && code != this {
                return Err(Failed::new(
                    true,
                    "服务器的回复前后不一致",
                    format!("reply code changed from {code} to {this}"),
                ));
            }
            code = this;
            if !text.is_empty() {
                text.push('\n');
            }
            text.push_str(line.get(4..).unwrap_or_default());
            // The end of the reply, or a single-line one.
            if line.len() == 3 || line.as_bytes()[3] == b' ' {
                return Ok((code, text));
            }
        }
    }

    /// One command and its reply.
    async fn cmd(&mut self, line: &str) -> Result<(u16, String), Failed> {
        write_line(self, line).await?;
        self.reply().await
    }

    /// The stream back, for the TLS upgrade. A server that sent anything past the
    /// reply it was asked for has its bytes sitting in this buffer, and carrying
    /// them into the encrypted session is how a downgrade attack works: refused
    /// rather than discarded.
    fn into_inner(self) -> Result<S, Failed> {
        if !self.io.buffer().is_empty() {
            return Err(Failed::fixed(
                "对方在加密握手前多发了一行数据，已放弃这次连接",
                "server sent data before the TLS handshake",
            ));
        }
        Ok(self.io.into_inner())
    }
}

async fn write_line<S>(conn: &mut Conn<S>, line: &str) -> Result<(), Failed>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    // Larger than a line of the dialogue on purpose: the payload goes through here
    // too, one write rather than one per header.
    let mut bytes = Vec::with_capacity(line.len() + 2);
    bytes.extend_from_slice(line.as_bytes());
    bytes.extend_from_slice(b"\r\n");
    let written = tokio::time::timeout(STEP, async {
        conn.io.get_mut().write_all(&bytes).await?;
        conn.io.get_mut().flush().await
    })
    .await;
    match written {
        Ok(Ok(())) => Ok(()),
        Ok(Err(e)) => Err(Failed::new(true, "发不出去：连接中断了", format!("{e}"))),
        Err(_) => Err(Failed::new(true, "发送超时", "write timed out")),
    }
}

/// Sends one line and waits for one of `codes`, or explains the refusal.
async fn command<S>(conn: &mut Conn<S>, step: Step, codes: &[u16], line: &str) -> Result<(), Failed>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    write_line(conn, line).await?;
    expect(conn, step, codes).await
}

/// Waits for one of `codes`, or explains the refusal.
async fn expect<S>(conn: &mut Conn<S>, step: Step, codes: &[u16]) -> Result<(), Failed>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let (code, text) = conn.reply().await?;
    if codes.contains(&code) {
        return Ok(());
    }
    Err(refused(step, code, &text))
}

/// What a refusal means to the operator, from the step and the code.
///
/// SMTP's first digit is the whole retry question: 4 is temporary ("try again"),
/// 5 is permanent ("stop"). The specific codes worth their own sentence are the
/// ones an operator can fix in the card -- a wrong password, a sender the relay
/// will not accept, a recipient it does not know.
fn refused(step: Step, code: u16, text: &str) -> Failed {
    let shown = match (step, code) {
        // A greeting that arrives and is a 4xx is a relay that is up and unwilling
        // right now -- the one case worth another attempt within the minute.
        (Step::Greeting, 450..=459) => "邮件服务暂时不可用，稍后再试",
        (Step::Greeting, _) | (Step::Ehlo, _) => {
            "对方不是邮件服务：检查端口与加密方式是否对应（465 用 tls，587 用 starttls）"
        }
        (Step::StartTls, _) => "对方拒绝了 STARTTLS：换 465 的 tls，或改选「不加密」",
        (Step::Auth, 535 | 534 | 530) => "用户名或密码不对",
        (Step::Auth, _) => "对方拒绝了这次登录",
        (Step::Mail, 550 | 553) => "发件人被拒绝：很多服务要求发件人就是登录账号本身",
        (Step::Mail, _) => "对方不接受这个发件人",
        (Step::Rcpt, 550 | 551 | 552) => "收件人被拒绝：地址不对，或对方不收这个域",
        (Step::Rcpt, _) => "对方不接受这个收件人",
        (Step::Data, 552 | 554) => "邮件被拒收，多半被判成了垃圾邮件",
        (Step::Data, _) => "对方不接受这封信",
        (Step::Body, 552 | 554) => "邮件被拒收，多半被判成了垃圾邮件",
        (Step::Body, _) => "对方拒收了这封信",
    };
    Failed::new(
        code / 100 == 4,
        format!("{shown}（{code}）"),
        format!("{} refused: {code} {text}", step.what()),
    )
}

/// The TLS handshake, with the roots compiled into the binary.
///
/// Not the system's trust store: a hub in a container has none to read, and one
/// that read it would trust a different set on every host. What this cannot do is
/// a relay with a private CA -- that one has to be reached unencrypted on a
/// network the operator controls, which is a documented limitation rather than a
/// switch that turns verification off.
async fn upgrade(
    stream: TcpStream,
    host: &str,
) -> Result<tokio_rustls::client::TlsStream<TcpStream>, Failed> {
    let name = rustls::pki_types::ServerName::try_from(host.to_owned())
        .map_err(|_| Failed::fixed("服务器地址不是一个合法的主机名", format!("bad server name: {host:?}")))?;
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| Failed::fixed("TLS 配置不可用", format!("{e}")))?
        .with_root_certificates(rustls::RootCertStore { roots: webpki_roots::TLS_SERVER_ROOTS.to_vec() })
        .with_no_client_auth();
    let handshake = TlsConnector::from(Arc::new(config)).connect(name, stream);
    let handshake = tokio::time::timeout(STEP, handshake)
        .await
        .map_err(|_| Failed::new(true, "加密握手超时", "TLS handshake timed out"))?;
    handshake.map_err(|e| {
        Failed::fixed(
            "加密握手失败：检查端口与加密方式是否对应（465 用 tls，587 用 starttls），以及证书是否可信",
            format!("{e}"),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncBufRead;

    fn server() -> Server {
        Server {
            host: "mail.example.com".into(),
            port: 587,
            security: Security::Plain,
            user: String::new(),
            password: String::new(),
        }
    }

    fn message() -> Message {
        Message {
            from: "probe@example.com".into(),
            to: vec!["ops@example.com".into()],
            subject: "🔴 香港 · 甲商家 离线".into(),
            body: "最后上报 09-15 20:13 +08:00\n第二行".into(),
        }
    }

    /// A fake relay: replies to each command from `script`, in order, and returns
    /// everything the client sent.
    fn relay(
        script: Vec<&'static str>,
        peer: tokio::io::DuplexStream,
    ) -> tokio::task::JoinHandle<Vec<String>> {
        tokio::spawn(async move {
            let (read, mut write) = tokio::io::split(peer);
            // One reader for the whole script: a buffer created per line would read
            // ahead and lose whatever arrived after the line it wanted.
            let mut reader = BufReader::new(read);
            let mut lines = Vec::new();
            let mut replies = script.into_iter();
            // The greeting is the one thing a server says without being asked.
            if let Some(greeting) = replies.next() {
                write.write_all(greeting.as_bytes()).await.unwrap();
            }
            while let Some(reply) = replies.next() {
                let line = read_one(&mut reader).await;
                lines.push(line.clone());
                write.write_all(reply.as_bytes()).await.unwrap();
                if line != "DATA" {
                    continue;
                }
                // What follows DATA is the message itself: several lines, ending
                // with a lone dot. Read whole and kept as one entry, so the
                // assertions see the payload as the client sent it.
                let mut payload = String::new();
                loop {
                    let next = read_one(&mut reader).await;
                    if next == "." {
                        break;
                    }
                    payload.push_str(&next);
                    payload.push_str("\r\n");
                }
                lines.push(payload);
                // The payload's own acknowledgement is the next reply in the script,
                // written now: the client is waiting for it before it says QUIT.
                if let Some(ack) = replies.next() {
                    write.write_all(ack.as_bytes()).await.unwrap();
                }
            }
            lines
        })
    }

    /// One line as the client sent it, without its CRLF.
    async fn read_one<S: AsyncBufRead + Unpin>(reader: &mut S) -> String {
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        line.trim_end_matches("\r\n").to_owned()
    }

    /// The whole conversation, in order, for a relay that wants no credentials --
    /// which is what a local postfix or a container's mailhog answers.
    #[tokio::test]
    async fn a_message_crosses_as_the_relay_expects() {
        let (client, peer) = tokio::io::duplex(64 * 1024);
        let peer = relay(
            vec![
                "220 mail.example.com ESMTP\r\n",
                "250-mail.example.com\r\n250-8BITMIME\r\n250 SIZE 10240000\r\n",
                "250 2.1.0 Ok\r\n",
                "250 2.1.5 Ok\r\n",
                "354 End data with <CR><LF>.<CR><LF>\r\n",
                "250 2.0.0 Ok: queued as 4Xy\r\n",
                "221 Bye\r\n",
            ],
            peer,
        );
        session(client, &server(), &message(), false).await.expect("delivered");
        let lines = peer.await.unwrap();

        assert!(lines[0].starts_with("EHLO "), "{}", lines[0]);
        assert_eq!(lines[1], "MAIL FROM:<probe@example.com>");
        assert_eq!(lines[2], "RCPT TO:<ops@example.com>");
        assert_eq!(lines[3], "DATA");
        assert_eq!(lines[5], "QUIT");

        // The payload: headers a person can read, a body that is base64 of exactly
        // what the template produced, and CRLF throughout.
        let payload = &lines[4];
        assert!(payload.starts_with("From: probe@example.com\r\nTo: ops@example.com\r\n"), "{payload}");
        assert!(payload.contains("Subject: =?UTF-8?B?"), "non-ASCII subject is encoded: {payload}");
        assert!(payload.contains("Message-ID: <"), "{payload}");
        assert!(payload.contains("Content-Transfer-Encoding: base64\r\n\r\n"), "{payload}");
        assert!(!payload.contains("\n\n"), "no bare LF anywhere in the payload");
        let body = payload.split("\r\n\r\n").nth(1).unwrap().replace("\r\n", "");
        let decoded = base64::engine::general_purpose::STANDARD.decode(body).unwrap();
        assert_eq!(String::from_utf8(decoded).unwrap(), message().body);
    }

    /// `AUTH PLAIN` in one round trip, which is what a relay that advertises it
    /// expects.
    #[tokio::test]
    async fn a_password_is_offered_as_auth_plain_when_the_relay_lists_it() {
        let (client, peer) = tokio::io::duplex(64 * 1024);
        let peer = relay(
            vec![
                "220 mail.example.com ESMTP\r\n",
                "250-mail.example.com\r\n250-AUTH PLAIN LOGIN\r\n250 SIZE 1\r\n",
                "235 2.7.0 Authentication successful\r\n",
                "250 Ok\r\n",
                "250 Ok\r\n",
                "354 go\r\n",
                "250 queued\r\n",
            ],
            peer,
        );
        let mut server = server();
        server.user = "probe".into();
        server.password = "s3cret".into();
        session(client, &server, &message(), false).await.expect("delivered");
        let lines = peer.await.unwrap();
        let expected = base64::engine::general_purpose::STANDARD.encode("\0probe\0s3cret");
        assert_eq!(lines[1], format!("AUTH PLAIN {expected}"), "the greeting took no line: {lines:?}");
    }

    /// `AUTH LOGIN`, for the relays that offer nothing else: two challenges, each
    /// answered with one base64 value.
    #[tokio::test]
    async fn auth_login_is_answered_when_that_is_all_the_relay_offers() {
        let (client, peer) = tokio::io::duplex(64 * 1024);
        let peer = relay(
            vec![
                "220 mail.example.com ESMTP\r\n",
                "250-mail.example.com\r\n250 AUTH LOGIN\r\n",
                "334 VXNlcm5hbWU6\r\n",
                "334 UGFzc3dvcmQ6\r\n",
                "235 Authentication successful\r\n",
                "250 Ok\r\n",
                "250 Ok\r\n",
                "354 go\r\n",
                "250 queued\r\n",
            ],
            peer,
        );
        let mut server = server();
        server.user = "probe".into();
        server.password = "s3cret".into();
        session(client, &server, &message(), false).await.expect("delivered");
        let lines = peer.await.unwrap();
        let engine = base64::engine::general_purpose::STANDARD;
        assert_eq!(lines[1], "AUTH LOGIN");
        assert_eq!(lines[2], engine.encode("probe"));
        assert_eq!(lines[3], engine.encode("s3cret"));
    }

    /// A refused password is not retried: the same credentials fail identically
    /// every time, and three attempts on a relay that counts them is how an
    /// account gets locked.
    #[tokio::test]
    async fn a_refused_password_says_so_and_is_not_retried() {
        let (client, peer) = tokio::io::duplex(64 * 1024);
        let peer = relay(
            vec![
                "220 mail.example.com ESMTP\r\n",
                "250-mail.example.com\r\n250 AUTH PLAIN\r\n",
                "535 5.7.8 Authentication credentials invalid\r\n",
            ],
            peer,
        );
        let mut server = server();
        server.user = "probe".into();
        server.password = "wrong".into();
        let failed = session(client, &server, &message(), false).await.err().expect("refused");
        assert!(!failed.retry, "a wrong password fails the same way next time");
        assert_eq!(failed.shown, "用户名或密码不对（535）");
        assert!(failed.reason.contains("535"), "the server's own words reach the log: {}", failed.reason);
        let _ = peer.await;
    }

    /// A recipient the relay does not know: permanent, and named as the recipient
    /// rather than as "the message failed".
    #[tokio::test]
    async fn a_rejected_recipient_is_named_as_one() {
        let (client, peer) = tokio::io::duplex(64 * 1024);
        let peer = relay(
            vec![
                "220 mail.example.com ESMTP\r\n",
                "250 mail.example.com\r\n",
                "250 Ok\r\n",
                "550 5.1.1 <ops@example.com>: Recipient address rejected\r\n",
            ],
            peer,
        );
        let failed = session(client, &server(), &message(), false).await.err().expect("refused");
        assert!(!failed.retry);
        assert!(failed.shown.starts_with("收件人被拒绝"), "{}", failed.shown);
    }

    /// A relay that is merely busy answers 4xx, which is worth another attempt:
    /// that is the whole distinction SMTP's first digit carries.
    #[tokio::test]
    async fn a_temporary_refusal_is_retried_and_a_permanent_one_is_not() {
        let (client, peer) = tokio::io::duplex(64 * 1024);
        let peer = relay(vec!["421 4.3.2 Service not available\r\n"], peer);
        let failed = session(client, &server(), &message(), false).await.err().expect("refused");
        assert!(failed.retry, "4xx is temporary");
        let _ = peer.await;

        // 5xx at the same step: the port is wrong, waiting will not fix it.
        let (client, peer) = tokio::io::duplex(64 * 1024);
        let peer = relay(vec!["554 5.3.2 No SMTP service here\r\n"], peer);
        let failed = session(client, &server(), &message(), false).await.err().expect("refused");
        assert!(!failed.retry, "5xx is permanent");
        assert!(failed.shown.contains("检查端口与加密方式"), "{}", failed.shown);
        let _ = peer.await;
    }

    /// The wrong port, or TLS where none is spoken: the client says what to check
    /// instead of timing out on a reply that will never come.
    #[tokio::test]
    async fn a_server_that_does_not_speak_smtp_is_told_apart_from_a_silent_one() {
        let (client, peer) = tokio::io::duplex(64 * 1024);
        let peer = tokio::spawn(async move {
            let (_, mut write) = tokio::io::split(peer);
            write.write_all(b"HTTP/1.1 400 Bad Request\r\n\r\n").await.unwrap();
        });
        let failed = session(client, &server(), &message(), false).await.err().expect("refused");
        assert!(failed.shown.contains("不是邮件服务"), "{}", failed.shown);
        let _ = peer.await;
    }

    /// STARTTLS is not optional where it was chosen: a relay that does not offer it
    /// would otherwise take the password in the clear.
    #[tokio::test]
    async fn starttls_that_the_relay_does_not_offer_is_refused() {
        let (client, peer) = tokio::io::duplex(64 * 1024);
        let peer =
            relay(vec!["220 mail.example.com ESMTP\r\n", "250-mail.example.com\r\n250 AUTH PLAIN\r\n"], peer);
        let mut conn = Conn::new(client);
        expect(&mut conn, Step::Greeting, &[220]).await.unwrap();
        let caps = ehlo(&mut conn, Step::Ehlo).await.unwrap();
        assert!(!caps.iter().any(|l| first_word(l).eq_ignore_ascii_case("STARTTLS")));
        let _ = peer.await;
    }

    /// A subject is encoded so that a Chinese one survives the header, and split so
    /// that no encoded word exceeds the 75 characters a header may carry.
    #[test]
    fn a_subject_is_encoded_per_word_and_ascii_is_left_alone() {
        assert_eq!(encode_header("Offline"), "Offline");
        let encoded = encode_header("香港 · 甲商家 离线，最后上报 09-15 20:13 +08:00");
        assert!(encoded.starts_with("=?UTF-8?B?"), "{encoded}");
        for word in encoded.split("\r\n ") {
            assert!(word.len() <= 75, "{} is {} chars", word, word.len());
            let body = word.trim_start_matches("=?UTF-8?B?").trim_end_matches("?=");
            base64::engine::general_purpose::STANDARD.decode(body).expect("each word decodes alone");
        }
        let joined: String = encoded
            .split("\r\n ")
            .map(|w| w.trim_start_matches("=?UTF-8?B?").trim_end_matches("?="))
            .map(|b| String::from_utf8(base64::engine::general_purpose::STANDARD.decode(b).unwrap()).unwrap())
            .collect();
        assert_eq!(joined, "香港 · 甲商家 离线，最后上报 09-15 20:13 +08:00");
    }

    /// A line holding one dot would end the message, so any line that starts with
    /// one is escaped on the way out. Nothing base64 produces needs it; a body
    /// written as text one day would.
    #[test]
    fn a_line_beginning_with_a_dot_is_escaped() {
        assert_eq!(stuffed("a\r\n.\r\nb"), "a\r\n..\r\nb");
        assert_eq!(stuffed("..already"), "...already");
        assert_eq!(stuffed("nothing.to.do"), "nothing.to.do");
    }

    /// Only the two mechanisms this client speaks are taken from the capability
    /// list, and a relay offering neither PLAIN nor LOGIN is refused with the list
    /// it wanted rather than silently tried unauthenticated.
    #[tokio::test]
    async fn an_unsupported_mechanism_is_named_rather_than_attempted() {
        let (client, peer) = tokio::io::duplex(64 * 1024);
        let peer = relay(
            vec!["220 mail.example.com ESMTP\r\n", "250-mail.example.com\r\n250 AUTH XOAUTH2\r\n"],
            peer,
        );
        let mut conn = Conn::new(client);
        expect(&mut conn, Step::Greeting, &[220]).await.unwrap();
        let caps = ehlo(&mut conn, Step::Ehlo).await.unwrap();
        let mut server = server();
        server.user = "probe".into();
        server.password = "s3cret".into();
        let failed = authenticate(&mut conn, &server, &caps).await.err().expect("refused");
        assert!(failed.shown.contains("XOAUTH2"), "{}", failed.shown);
        let _ = peer.await;
    }

    /// Nothing is sent to a relay that advertises no AUTH at all: it authenticates
    /// by address, and an AUTH line would be refused. The peer is dropped first, so
    /// a write would fail rather than go unnoticed.
    #[tokio::test]
    async fn a_relay_with_no_mechanism_is_taken_at_its_word() {
        let (client, peer) = tokio::io::duplex(1024);
        drop(peer);
        let mut conn = Conn::new(client);
        let caps = vec!["mail.example.com".to_owned(), "SIZE 1024".to_owned()];
        let mut server = server();
        server.user = "probe".into();
        authenticate(&mut conn, &server, &caps).await.expect("nothing to send");
    }
}
