use std::env;

fn resolve_env(nomo_key: &str, void_key: &str) -> Option<String> {
    match env::var(nomo_key) {
        Ok(val) => Some(val),
        Err(_) => env::var(void_key).ok(),
    }
}

fn main() {
    env::set_var("NOMO_TEST", "nomo");
    env::set_var("VOID_TEST", "void");
    assert_eq!(resolve_env("NOMO_TEST", "VOID_TEST"), Some("nomo".to_string()));

    env::remove_var("NOMO_TEST");
    assert_eq!(resolve_env("NOMO_TEST", "VOID_TEST"), Some("void".to_string()));

    env::set_var("NOMO_TEST", "");
    assert_eq!(resolve_env("NOMO_TEST", "VOID_TEST"), Some("".to_string()));

    env::remove_var("NOMO_TEST");
    env::remove_var("VOID_TEST");
    assert_eq!(resolve_env("NOMO_TEST", "VOID_TEST"), None);
    println!("Tests passed!");
}
