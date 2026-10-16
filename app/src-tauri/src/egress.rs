// "Nothing leaves your laptop", kept honest by a test. Bond's code may use the network in three
// places only: downloading his own brain and voice files (brain.rs, voice.rs, wake.rs), and
// talking to the brain on 127.0.0.1. Nothing may know the address of an AI service. If someone
// adds a cloud call later, this fails and says where.

#[cfg(test)]
mod tests {
    use std::path::Path;

    fn sources() -> Vec<(String, String)> {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut out = Vec::new();
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            let name = path.file_name().unwrap().to_string_lossy().to_string();
            if name.ends_with(".rs") && name != "egress.rs" {
                out.push((name, std::fs::read_to_string(&path).unwrap()));
            }
        }
        out
    }

    #[test]
    fn only_model_downloads_and_the_local_brain_use_the_network() {
        let mut users: Vec<String> = sources().into_iter().filter(|(_, text)| text.contains("reqwest::Client")).map(|(name, _)| name).collect();
        users.sort();
        assert_eq!(users, ["brain.rs", "voice.rs", "wake.rs"], "a new file talks to the network: is it a download, or does it send something away?");
    }

    #[test]
    fn no_ai_service_is_known_to_the_code() {
        for (name, text) in sources() {
            for host in ["googleapis.com", "api.anthropic.com", "api.openai.com", "api.x.ai", "api.groq.com", "openrouter.ai", "api.mistral.ai", "api.cohere", "huggingface.co/api", "inference"] {
                assert!(!text.contains(host), "{name} mentions {host}");
            }
        }
    }

    #[test]
    fn the_brain_is_only_asked_on_this_laptop() {
        let brain = sources().into_iter().find(|(n, _)| n == "brain.rs").unwrap().1;
        // (`http.get(url)` is the one-time download of the model files, in `download`.)
        for line in brain.lines().filter(|l| l.contains(".post(") || l.contains(".get(format!")) {
            assert!(line.contains("127.0.0.1"), "brain.rs sends a request somewhere other than this laptop: {line}");
        }
    }
}
