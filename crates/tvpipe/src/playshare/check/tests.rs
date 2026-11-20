//! `tvpipe game check`'s checks, one rule at a time, on games written into
//! scratch folders (and zips made from them).

use std::path::{Path, PathBuf};

use super::*;
use crate::util::zip_write;

fn scratch(name: &str) -> PathBuf {
    let d = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../target/test-tmp/bundle")
        .join(format!("{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// This tvpipe's series (`0.3`).
fn series() -> String {
    short_version(env!("CARGO_PKG_VERSION"))
}

/// A manifest that passes, made for this tvpipe.
fn manifest_ok() -> String {
    format!(
        r#"{{
  "name": "tiny",
  "title": "Tiny",
  "tvpipe": "{}",
  "pages": {{ "host": "host.html", "tv": "tv.html", "phone": "phone/index.html" }},
  "players": {{ "min": 1, "max": 8 }}
}}
"#,
        series()
    )
}

/// A game that passes: host, TV and phone pages with the library.
fn good() -> Vec<(&'static str, String)> {
    vec![
        ("tvpipe.json", manifest_ok()),
        (
            "host.html",
            "<!doctype html><link rel=stylesheet href=style.css><script type=module src=host.js></script>".into(),
        ),
        (
            "host.js",
            "import { Tvpipe } from \"/_tvpipe/lib/index.js\";\nimport { rules } from './rules.js';\n".into(),
        ),
        ("rules.js", "export const rules = 1;\n".into()),
        ("style.css", "body { background: url(img/bg.png) }\n".into()),
        ("img/bg.png", "png".into()),
        (
            "tv.html",
            "<!doctype html><script type=module>import { PartyClient } from '/_tvpipe/lib/client.js';</script>".into(),
        ),
        (
            "phone/index.html",
            "<!doctype html><link rel=stylesheet href=../style.css><script type=module src=phone.js></script>".into(),
        ),
        ("phone/phone.js", "import { PartyClient } from \"/_tvpipe/lib/client.js\";\n".into()),
    ]
}

fn write(dir: &Path, files: &[(&str, String)]) {
    for (p, text) in files {
        let path = dir.join(p);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }
}

/// `good()` with changes: `Some` replaces or adds a file, `None` removes it.
fn game(name: &str, changes: &[(&'static str, Option<&str>)]) -> PathBuf {
    let dir = scratch(name);
    let mut files = good();
    for (p, c) in changes {
        files.retain(|f| f.0 != *p);
        if let Some(c) = c {
            files.push((p, (*c).to_owned()));
        }
    }
    write(&dir, &files);
    dir
}

fn zip_of(name: &str, entries: &[(&str, &str)]) -> PathBuf {
    let dir = scratch(name);
    let e: Vec<(String, Vec<u8>)> = entries
        .iter()
        .map(|(n, d)| ((*n).to_owned(), d.as_bytes().to_vec()))
        .collect();
    let p = dir.join("game.zip");
    std::fs::write(&p, zip_write::write(&e).unwrap()).unwrap();
    p
}

fn as_str(v: &[(String, String)]) -> Vec<(&str, &str)> {
    v.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect()
}

fn good_zip_entries(prefix: &str) -> Vec<(String, String)> {
    good()
        .into_iter()
        .map(|(p, t)| (format!("{prefix}{p}"), t))
        .collect()
}

/// The problems as `level at: message` lines.
fn lines(c: &Checked) -> Vec<String> {
    c.problems.iter().map(ToString::to_string).collect()
}

/// Exactly one problem, at `level`, containing every one of `parts`.
#[track_caller]
fn only(c: &Checked, level: Level, parts: &[&str]) {
    let l = lines(c);
    assert_eq!(c.problems.len(), 1, "{l:#?}");
    assert_eq!(c.problems[0].level, level, "{l:#?}");
    for p in parts {
        assert!(l[0].contains(p), "{p:?} not in {l:#?}");
    }
}

#[track_caller]
fn has(c: &Checked, level: Level, parts: &[&str]) {
    let l = lines(c);
    assert!(
        c.problems
            .iter()
            .any(|p| p.level == level && parts.iter().all(|x| p.to_string().contains(x))),
        "{parts:?} not in {l:#?}"
    );
}

#[test]
fn a_good_game_is_clean_and_packs_deterministically() {
    let dir = game("good", &[]);
    // Hidden files are neither served nor packed.
    write(
        &dir,
        &[(".DS_Store", "x".into()), (".git/config", "x".into())],
    );
    let c = check(&dir).unwrap();
    assert!(c.problems.is_empty(), "{:#?}", lines(&c));
    assert_eq!(c.skipped, 2);
    assert_eq!(c.size().0, 9);
    let z = pack(&c).unwrap();
    assert_eq!(
        pack(&check(&dir).unwrap()).unwrap(),
        z,
        "same input, same bytes"
    );
    let entries = zip::read(&z, zip::Limits::default()).unwrap();
    let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(
        names,
        [
            "tiny/host.html",
            "tiny/host.js",
            "tiny/img/bg.png",
            "tiny/phone/index.html",
            "tiny/phone/phone.js",
            "tiny/rules.js",
            "tiny/style.css",
            "tiny/tv.html",
            "tiny/tvpipe.json",
        ]
    );
    // The zip checks clean too, and playshare opens it.
    let out = scratch("good-out").join("tiny.zip");
    std::fs::write(&out, &z).unwrap();
    let c = check(&out).unwrap();
    assert!(c.problems.is_empty(), "{:#?}", lines(&c));
    assert!(Bundle::open(&out).is_ok());
    assert!(
        c.render()
            .ends_with("Tiny (tiny): 9 files, 665 bytes; 0 errors, 0 warnings\n"),
        "{}",
        c.render()
    );
}

#[test]
fn root_is_packed_without_the_rest() {
    let dir = scratch("root");
    let mut files: Vec<(&str, String)> = good()
        .into_iter()
        .filter(|f| f.0 != "tvpipe.json")
        .map(|(p, t)| (Box::leak(format!("dist/{p}").into_boxed_str()) as &str, t))
        .collect();
    files.push((
        "tvpipe.json",
        manifest_ok().replace(
            "\"pages\"",
            "\"root\": \"dist\",\n  \"future\": 1,\n  \"pages\"",
        ),
    ));
    files.push(("src/host.ts", "export {}".into()));
    files.push(("package.json", "{}".into()));
    write(&dir, &files);
    let c = check(&dir).unwrap();
    only(
        &c,
        Level::Warning,
        &["tvpipe.json", "unknown field \"future\""],
    );
    let z = pack(&c).unwrap();
    let entries = zip::read(&z, zip::Limits::default()).unwrap();
    assert_eq!(entries.len(), 9);
    assert!(entries
        .iter()
        .all(|e| !e.name.contains("src/") && !e.name.contains("package")));
    let m = entries
        .iter()
        .find(|e| e.name == "tiny/tvpipe.json")
        .unwrap();
    let m = String::from_utf8_lossy(&m.data);
    assert!(!m.contains("root") && m.contains("\"future\": 1"), "{m}");
    // Without the build: the root is missing.
    std::fs::remove_dir_all(dir.join("dist")).unwrap();
    let c = check(&dir).unwrap();
    assert_eq!(c.errors(), 1, "{:#?}", lines(&c));
    has(
        &c,
        Level::Error,
        &["\"root\" \"dist\" does not exist", "build"],
    );
}

#[test]
fn manifest_rules() {
    let c = check(&game("no-manifest", &[("tvpipe.json", None)])).unwrap();
    only(&c, Level::Error, &["no tvpipe.json", "game new"]);
    let c = check(&game("bad-json", &[("tvpipe.json", Some("{"))])).unwrap();
    only(&c, Level::Error, &["tvpipe.json: not JSON"]);
    let c = check(&game(
        "no-tv",
        &[("tvpipe.json", Some(&format!(r#"{{"name":"x","tvpipe":"{}","pages":{{"host":"host.html","phone":"phone/index.html"}}}}"#, series())))],
    ))
    .unwrap();
    only(&c, Level::Error, &["\"pages.tv\" is missing"]);
    let c = check(&game(
        "bad-name",
        &[(
            "tvpipe.json",
            Some(&manifest_ok().replace("\"tiny\"", "\"Tiny Game\"")),
        )],
    ))
    .unwrap();
    only(&c, Level::Error, &["\"name\" must be 1-40 of a-z"]);
    let c = check(&game(
        "players",
        &[(
            "tvpipe.json",
            Some(&manifest_ok().replace("\"max\": 8", "\"max\": 5000")),
        )],
    ))
    .unwrap();
    only(&c, Level::Error, &["players.max"]);
    let c = check(&game(
        "typo",
        &[(
            "tvpipe.json",
            Some(&manifest_ok().replace("\"host\":", "\"hots\": \"x.html\", \"host\":")),
        )],
    ))
    .unwrap();
    only(&c, Level::Warning, &["unknown page \"pages.hots\""]);
}

#[test]
fn versions() {
    assert!(version_compatible("0.2", "0.2.0").is_ok());
    assert!(version_compatible("0.2.0", "0.2.5").is_ok());
    assert!(version_compatible("1.0", "1.4.0").is_ok());
    assert!(version_compatible("0.2.1", "0.2.0")
        .unwrap_err()
        .contains("update tvpipe"));
    assert!(version_compatible("0.3", "0.2.0")
        .unwrap_err()
        .contains("update tvpipe"));
    assert!(version_compatible("0.1", "0.2.0")
        .unwrap_err()
        .contains("update the game"));
    assert!(version_compatible("1.2", "2.0.0")
        .unwrap_err()
        .contains("update the game"));
    assert!(version_compatible("latest", "0.2.0")
        .unwrap_err()
        .contains("like \"0.2\""));
    let none = manifest_ok().replace(&format!("  \"tvpipe\": \"{}\",\n", series()), "");
    let c = check(&game("no-version", &[("tvpipe.json", Some(&none))])).unwrap();
    only(
        &c,
        Level::Warning,
        &[
            "no \"tvpipe\" version",
            &format!("\"tvpipe\": \"{}\"", series()),
        ],
    );
    let c = check(&game(
        "future",
        &[(
            "tvpipe.json",
            Some(&manifest_ok().replace(&format!("\"{}\"", series()), "\"9.0\"")),
        )],
    ))
    .unwrap();
    only(&c, Level::Error, &["needs tvpipe 9.0 or newer"]);
}

#[test]
fn pages_must_exist() {
    let c = check(&game("no-phone", &[("phone/index.html", None)])).unwrap();
    only(
        &c,
        Level::Error,
        &["\"pages.phone\": phone/index.html is not in the game"],
    );
    let c = check(&game(
        "case",
        &[
            ("tv.html", None),
            (
                "TV.html",
                Some("<script type=module src=/_tvpipe/lib/client.js></script>"),
            ),
        ],
    ))
    .unwrap();
    only(
        &c,
        Level::Error,
        &["\"pages.tv\"", "TV.html differs in case"],
    );
}

#[test]
fn missing_references_with_lines() {
    let c = check(&game(
        "missing",
        &[
            ("style.css", Some("\n\n.x { background: url(\"../img/gone.png\") }\n@import 'more.css';\n")),
            ("rules.js", Some("import './helpers';\nexport const x = await import('./lazy.js');\n")),
            ("helpers.js", Some("")),
            ("img/BG.png", Some("x")),
            ("img/bg.png", None),
            ("tv.html", Some("<script type=module src=/_tvpipe/lib/client.js></script>\n<img src=\"img/bg.png\"><a href=\"rules.html\">rules</a>")),
        ],
    ))
    .unwrap();
    let l = lines(&c);
    assert_eq!(c.errors(), 5, "{l:#?}");
    has(
        &c,
        Level::Error,
        &[
            "rules.js:1: import \"./helpers\"",
            "did you mean helpers.js?",
        ],
    );
    has(
        &c,
        Level::Error,
        &["rules.js:2: import() \"./lazy.js\": lazy.js is not in the game"],
    );
    has(
        &c,
        Level::Error,
        &["style.css:3: \"../img/gone.png\" leads above the game's root"],
    );
    has(
        &c,
        Level::Error,
        &[
            "tv.html:2: file \"img/bg.png\"",
            "img/BG.png differs in case",
        ],
    );
    has(&c, Level::Error, &["style.css:4: style sheet \"more.css\""]);
    // A missing link is a warning.
    has(&c, Level::Warning, &["tv.html:2: link \"rules.html\""]);
}

#[test]
fn remote_files_are_warnings() {
    let c = check(&game(
        "remote",
        &[(
            "phone/index.html",
            Some("<link rel=stylesheet href=\"https://fonts.example/css\"><script type=module src=phone.js></script><a href=\"https://example.com\">site</a>"),
        )],
    ))
    .unwrap();
    only(
        &c,
        Level::Warning,
        &[
            "phone/index.html:1",
            "style sheet from the internet (https://fonts.example/css)",
        ],
    );
}

#[test]
fn library_rules() {
    // A bare import without an import map.
    let c = check(&game(
        "bare",
        &[(
            "host.js",
            Some("import { Tvpipe } from \"@tvpipe/party\";\n"),
        )],
    ))
    .unwrap();
    has(
        &c,
        Level::Error,
        &[
            "host.js:1: bare import \"@tvpipe/party\"",
            "\"/_tvpipe/lib/index.js\"",
        ],
    );
    // An import map resolves it.
    let c = check(&game(
        "importmap",
        &[
            ("host.js", Some("import { Tvpipe } from \"@tvpipe/party\";\nimport { r } from 'game/rules.js';\n")),
            ("host.html", Some("<script type=importmap>{\"imports\":{\"@tvpipe/party\":\"/_tvpipe/lib/index.js\",\"game/\":\"./\"}}</script><script type=module src=host.js></script>")),
        ],
    ))
    .unwrap();
    assert!(c.problems.is_empty(), "{:#?}", lines(&c));
    // tvpipe's look and its fonts.
    let c = check(&game(
        "look",
        &[
            ("host.css", Some("@import \"/_tvpipe/ui.css\";\n@font-face { src: url(/_tvpipe/fonts/michroma.woff2) }\n@font-face { src: url(/_tvpipe/fonts/comic-sans.woff2) }\n")),
            ("host.html", Some("<link rel=stylesheet href=/_tvpipe/ui.css><link rel=stylesheet href=host.css><script type=module src=host.js></script>")),
        ],
    ))
    .unwrap();
    only(
        &c,
        Level::Error,
        &[
            "host.css:3: /_tvpipe/fonts/comic-sans.woff2 does not exist",
            "/_tvpipe/ui.css",
        ],
    );
    // A library module tvpipe does not have.
    let c = check(&game(
        "nolib",
        &[(
            "phone/phone.js",
            Some("import { X } from \"/_tvpipe/lib/nope.js\";\n"),
        )],
    ))
    .unwrap();
    has(
        &c,
        Level::Error,
        &[
            "phone/phone.js:1: /_tvpipe/lib/nope.js does not exist",
            "client.js",
        ],
    );
    has(
        &c,
        Level::Warning,
        &["phone/index.html: the phone page does not load"],
    );
    // A host page without the library.
    let c = check(&game("nohost", &[("host.js", Some("console.log(1)"))])).unwrap();
    only(
        &c,
        Level::Warning,
        &["host.html: the host page does not load @tvpipe/party"],
    );
    // A TV page without the client: a warning, unless the host streams a
    // canvas (a surface), which is then the TV picture.
    let plain_tv = ("tv.html", Some("<!doctype html><canvas></canvas>"));
    let c = check(&game("plaintv", &[plain_tv])).unwrap();
    only(
        &c,
        Level::Warning,
        &["tv.html: the tv page does not load @tvpipe/party's client"],
    );
    let host = "import { Tvpipe } from \"/_tvpipe/lib/index.js\";\nimport { rules } from './rules.js';\nconst tv = await (await Tvpipe.connect()).surface({ canvas });\n";
    let c = check(&game("surfacetv", &[plain_tv, ("host.js", Some(host))])).unwrap();
    assert!(c.problems.is_empty(), "{:#?}", lines(&c));
    // A bundled copy.
    let c = check(&game(
        "copy",
        &[(
            "rules.js",
            Some("export class PartyClient {}\nexport const rules = 1;"),
        )],
    ))
    .unwrap();
    only(
        &c,
        Level::Warning,
        &["rules.js: has a copy of @tvpipe/party"],
    );
}

#[test]
fn scripts_that_cannot_run() {
    let c = check(&game(
        "ts",
        &[
            (
                "host.html",
                Some("<script type=module src=host.ts></script>"),
            ),
            (
                "host.ts",
                Some("import { Tvpipe } from \"/_tvpipe/lib/index.js\";"),
            ),
        ],
    ))
    .unwrap();
    has(
        &c,
        Level::Error,
        &["host.html:1", "host.ts: browsers do not run TypeScript"],
    );
    let c = check(&game(
        "classic",
        &[("host.html", Some("<script src=host.js></script>"))],
    ))
    .unwrap();
    only(&c, Level::Error, &["host.html:1", "add type=\"module\""]);
}

#[test]
fn reserved_and_odd_names() {
    let c = check(&game("reserved", &[("_tvpipe/lib/index.js", Some("x"))])).unwrap();
    only(&c, Level::Error, &["_tvpipe: /_tvpipe/ is tvpipe's own"]);
    // Windows cannot even write such a file: the check runs elsewhere.
    if cfg!(not(windows)) {
        let c = check(&game("windows", &[("img/what?.png", Some("x"))])).unwrap();
        only(
            &c,
            Level::Warning,
            &["img/what?.png: the name cannot be unpacked on Windows"],
        );
    }
    let c = check(&game("nm", &[("node_modules/x/index.js", Some("x"))])).unwrap();
    only(&c, Level::Warning, &["node_modules is served and packed"]);
}

#[cfg(unix)]
#[test]
fn symlinks() {
    let dir = game("symlinks", &[]);
    let outside = scratch("symlinks-outside");
    std::fs::write(outside.join("secret.png"), "s").unwrap();
    std::os::unix::fs::symlink(outside.join("secret.png"), dir.join("img/leak.png")).unwrap();
    std::os::unix::fs::symlink(dir.join("img"), dir.join("pictures")).unwrap();
    std::os::unix::fs::symlink(dir.join("nowhere"), dir.join("broken.png")).unwrap();
    std::os::unix::fs::symlink(dir.join("img"), dir.join("img/again")).unwrap();
    let c = check(&dir).unwrap();
    let l = lines(&c);
    assert_eq!(c.problems.len(), 5, "{l:#?}");
    has(&c, Level::Error, &["pictures/leak.png: a symlink to"]);
    has(
        &c,
        Level::Error,
        &["img/again: a symlink to a folder that contains it"],
    );
    has(
        &c,
        Level::Error,
        &["img/leak.png: a symlink to", "outside the game's root"],
    );
    has(&c, Level::Error, &["broken.png: a broken symlink"]);
    // A symlink inside is followed (and packed as a copy).
    assert!(c.paths().any(|p| p == "pictures/bg.png"));
}

#[test]
fn zip_rules() {
    let good: Vec<(String, String)> = good_zip_entries("tiny/");
    let refs = |v: &[(String, String)]| -> Vec<(String, String)> { v.to_vec() };
    // At the top, or in one folder.
    let c = check(&zip_of("zip-top", &as_str(&good_zip_entries("")))).unwrap();
    assert!(c.problems.is_empty(), "{:#?}", lines(&c));
    let c = check(&zip_of("zip-folder", &as_str(&good))).unwrap();
    assert!(c.problems.is_empty(), "{:#?}", lines(&c));
    // Too deep.
    let c = check(&zip_of("zip-deep", &as_str(&good_zip_entries("a/b/")))).unwrap();
    only(
        &c,
        Level::Error,
        &["no tvpipe.json at the top", "a/b/tvpipe.json is deeper"],
    );
    // Finder's __MACOSX and a .DS_Store next to the folder: playshare
    // loads it, the check only warns.
    let mut v = refs(&good);
    v.push(("__MACOSX/tiny/._host.html".into(), "x".into()));
    v.push((".DS_Store".into(), "x".into()));
    let c = check(&zip_of("zip-macosx", &as_str(&v))).unwrap();
    assert_eq!(c.errors(), 0, "{:#?}", lines(&c));
    has(&c, Level::Warning, &["__MACOSX/", "Finder"]);
    // Unsafe names.
    let mut v = refs(&good);
    v.push(("tiny/../../evil.sh".into(), "x".into()));
    v.push(("/etc/passwd".into(), "x".into()));
    let c = check(&zip_of("zip-unsafe", &as_str(&v))).unwrap();
    assert_eq!(c.errors(), 2, "{:#?}", lines(&c));
    has(&c, Level::Error, &["tiny/../../evil.sh: an unsafe name"]);
    // Case collisions (a zip can hold both).
    let mut v = refs(&good);
    v.push(("tiny/img/BG.png".into(), "x".into()));
    v.push(("tiny/Img/other.png".into(), "x".into()));
    let c = check(&zip_of("zip-case", &as_str(&v))).unwrap();
    has(
        &c,
        Level::Error,
        &["img/bg.png: differs from img/BG.png only in case"],
    );
    has(
        &c,
        Level::Error,
        &["the folder differs from Img only in case"],
    );
    // Files outside root.
    let mut v: Vec<(String, String)> = good_zip_entries("tiny/dist/")
        .into_iter()
        .filter(|e| !e.0.ends_with("tvpipe.json"))
        .collect();
    v.push((
        "tiny/tvpipe.json".into(),
        manifest_ok().replace("\"pages\"", "\"root\": \"dist\", \"pages\""),
    ));
    v.push(("tiny/src/x.ts".into(), "x".into()));
    let c = check(&zip_of("zip-root", &as_str(&v))).unwrap();
    only(&c, Level::Warning, &["1 files outside \"root\" \"dist\""]);
    // Not a zip.
    let p = scratch("not-zip").join("x.zip");
    std::fs::write(&p, "hello").unwrap();
    only(&check(&p).unwrap(), Level::Error, &["not a zip archive"]);
}

#[test]
fn zip_duplicates() {
    let mut v = good_zip_entries("tiny/");
    v.push(("tiny/dup-a.png".into(), "1".into()));
    v.push(("tiny/dup-b.png".into(), "2".into()));
    let e: Vec<(String, Vec<u8>)> = v.into_iter().map(|(a, b)| (a, b.into_bytes())).collect();
    let mut z = zip_write::write(&e).unwrap();
    // Rename dup-b to dup-a in both headers.
    let from = b"tiny/dup-b.png";
    let mut i = 0;
    while i + from.len() <= z.len() {
        if &z[i..i + from.len()] == from {
            z[i + 9] = b'a';
        }
        i += 1;
    }
    let p = scratch("zip-dup").join("game.zip");
    std::fs::write(&p, z).unwrap();
    only(
        &check(&p).unwrap(),
        Level::Error,
        &["tiny/dup-a.png: twice in the archive"],
    );
}

#[test]
fn limits() {
    // Too many files (the count alone, the files are empty).
    let dir = game("many", &[]);
    for i in 0..MAX_FILES {
        let d = dir.join(format!("many/{}", i / 1000));
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join(format!("{i}.txt")), "").unwrap();
    }
    has(
        &check(&dir).unwrap(),
        Level::Error,
        &["files: a bundle holds at most 10000"],
    );
}

/// Drawbluff, when it is built (`npm run build` in games/drawbluff).
#[test]
fn drawbluff_bundles_cleanly() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../games/drawbluff");
    if !dir.join("dist/host/host.js").exists() {
        eprintln!("games/drawbluff is not built: skipped");
        return;
    }
    let c = check(&dir).unwrap();
    assert_eq!(c.errors(), 0, "{}", c.render());
    let z = pack(&c).unwrap();
    let out = scratch("drawbluff").join("drawbluff.zip");
    std::fs::write(&out, &z).unwrap();
    assert_eq!(check(&out).unwrap().errors(), 0);
}
