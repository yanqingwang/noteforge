
use nf_crypto::JoplinE2ee;

fn main() {
    let json = std::fs::read_to_string("/home/wang/文档/test2/.noteforge/sync-config.json").unwrap();
    let cfg: serde_json::Value = serde_json::from_str(&json).unwrap();
    let mk_id = cfg["e2ee_master_key_id"].as_str().unwrap();
    let pwd = cfg["e2ee_password"].as_str().unwrap();
    let mk_content = cfg["e2ee_master_key_content"].as_str().unwrap();

    let mut e2ee = JoplinE2ee::new();
    e2ee.load_master_key(mk_id, pwd, mk_content).expect("load master key");
    println!("✅ loaded config master key {}", mk_id);

    let plain = "# Hello\n\n加密内容安全\ncontent";
    let cipher = e2ee.encrypt_item(plain, mk_id).expect("encrypt");
    println!("✅ cipher header: {}", &cipher[..35]);

    let decrypted = e2ee.decrypt_item(&cipher).expect("decrypt");
    println!("✅ roundtrip match: {}", decrypted == plain);
}
