//! タグのローマ字順に使う、名前の並べ替えのキー

/// ひらがな（拗音を含む）とローマ字（ヘボン式）の対応。長いもの（2文字）から先に調べる
const KANA: &[(&str, &str)] = &[
    ("きゃ", "kya"), ("きゅ", "kyu"), ("きょ", "kyo"), ("しゃ", "sha"), ("しゅ", "shu"), ("しょ", "sho"),
    ("ちゃ", "cha"), ("ちゅ", "chu"), ("ちょ", "cho"), ("にゃ", "nya"), ("にゅ", "nyu"), ("にょ", "nyo"),
    ("ひゃ", "hya"), ("ひゅ", "hyu"), ("ひょ", "hyo"), ("みゃ", "mya"), ("みゅ", "myu"), ("みょ", "myo"),
    ("りゃ", "rya"), ("りゅ", "ryu"), ("りょ", "ryo"), ("ぎゃ", "gya"), ("ぎゅ", "gyu"), ("ぎょ", "gyo"),
    ("じゃ", "ja"), ("じゅ", "ju"), ("じょ", "jo"), ("ぢゃ", "ja"), ("ぢゅ", "ju"), ("ぢょ", "jo"),
    ("びゃ", "bya"), ("びゅ", "byu"), ("びょ", "byo"), ("ぴゃ", "pya"), ("ぴゅ", "pyu"), ("ぴょ", "pyo"),
    ("しぇ", "she"), ("ちぇ", "che"), ("じぇ", "je"), ("てぃ", "ti"), ("でぃ", "di"), ("とぅ", "tu"),
    ("ふぁ", "fa"), ("ふぃ", "fi"), ("ふぇ", "fe"), ("ふぉ", "fo"), ("うぃ", "wi"), ("うぇ", "we"),
    ("ゔぁ", "va"), ("ゔぃ", "vi"), ("ゔぇ", "ve"), ("ゔぉ", "vo"),
    ("あ", "a"), ("い", "i"), ("う", "u"), ("え", "e"), ("お", "o"),
    ("か", "ka"), ("き", "ki"), ("く", "ku"), ("け", "ke"), ("こ", "ko"),
    ("さ", "sa"), ("し", "shi"), ("す", "su"), ("せ", "se"), ("そ", "so"),
    ("た", "ta"), ("ち", "chi"), ("つ", "tsu"), ("て", "te"), ("と", "to"),
    ("な", "na"), ("に", "ni"), ("ぬ", "nu"), ("ね", "ne"), ("の", "no"),
    ("は", "ha"), ("ひ", "hi"), ("ふ", "fu"), ("へ", "he"), ("ほ", "ho"),
    ("ま", "ma"), ("み", "mi"), ("む", "mu"), ("め", "me"), ("も", "mo"),
    ("や", "ya"), ("ゆ", "yu"), ("よ", "yo"),
    ("ら", "ra"), ("り", "ri"), ("る", "ru"), ("れ", "re"), ("ろ", "ro"),
    ("わ", "wa"), ("ゐ", "i"), ("ゑ", "e"), ("を", "o"), ("ん", "n"),
    ("が", "ga"), ("ぎ", "gi"), ("ぐ", "gu"), ("げ", "ge"), ("ご", "go"),
    ("ざ", "za"), ("じ", "ji"), ("ず", "zu"), ("ぜ", "ze"), ("ぞ", "zo"),
    ("だ", "da"), ("ぢ", "ji"), ("づ", "zu"), ("で", "de"), ("ど", "do"),
    ("ば", "ba"), ("び", "bi"), ("ぶ", "bu"), ("べ", "be"), ("ぼ", "bo"),
    ("ぱ", "pa"), ("ぴ", "pi"), ("ぷ", "pu"), ("ぺ", "pe"), ("ぽ", "po"),
    ("ゔ", "vu"), ("ぁ", "a"), ("ぃ", "i"), ("ぅ", "u"), ("ぇ", "e"), ("ぉ", "o"),
    ("ゃ", "ya"), ("ゅ", "yu"), ("ょ", "yo"), ("ゎ", "wa"),
];

/// カタカナをひらがなに、全角の英数字・記号を半角にする
fn fold(c: char) -> char {
    match c {
        'ァ'..='ヶ' => char::from_u32(c as u32 - 0x60).unwrap_or(c),
        '！'..='～' => char::from_u32(c as u32 - 0xFEE0).unwrap_or(c),
        _ => c,
    }
}

/// 名前をローマ字にした並べ替えのキー。ひらがな・カタカナはローマ字にし、英字は小文字にする。
/// 漢字などはそのまま残る（文字コードが大きいので、ローマ字の後ろに並ぶ）
pub fn romaji_key(name: &str) -> String {
    let chars: Vec<char> = name.chars().map(fold).collect();
    let mut out = String::new();
    // 直前の「っ」。次の音の最初の子音を重ねる
    let mut sokuon = false;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == 'っ' {
            sokuon = true;
            i += 1;
            continue;
        }
        let two: String = chars[i..chars.len().min(i + 2)].iter().collect();
        let one = c.to_string();
        let hit = KANA
            .iter()
            .find(|(k, _)| *k == two && two.chars().count() == 2)
            .or_else(|| KANA.iter().find(|(k, _)| *k == one));
        match hit {
            Some((k, r)) => {
                if sokuon {
                    // 「っち」は tchi
                    let first = if r.starts_with("ch") { 't' } else { r.chars().next().unwrap_or('t') };
                    out.push(first);
                }
                out.push_str(r);
                i += k.chars().count();
            }
            None => {
                if sokuon {
                    out.push_str("tsu");
                }
                // 長音は、直前の母音を伸ばす
                if c == 'ー' {
                    if let Some(v) = out.chars().last().filter(|v| "aiueo".contains(*v)) {
                        out.push(v);
                    }
                } else {
                    out.extend(c.to_lowercase());
                }
                i += 1;
            }
        }
        sokuon = false;
    }
    if sokuon {
        out.push_str("tsu");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kana_becomes_hepburn_romaji() {
        assert_eq!(romaji_key("あめ"), "ame");
        assert_eq!(romaji_key("カゼ"), "kaze");
        assert_eq!(romaji_key("しゃっきり"), "shakkiri");
        assert_eq!(romaji_key("マッチ"), "matchi");
        assert_eq!(romaji_key("ボーナス"), "boonasu");
        assert_eq!(romaji_key("BGM ｂｇｍ"), "bgm bgm");
        // 漢字はそのまま後ろに残る
        assert_eq!(romaji_key("雨の音"), "雨no音");
    }
}
