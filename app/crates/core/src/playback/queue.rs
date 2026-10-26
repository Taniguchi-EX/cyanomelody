//! 再生順の制御。プレイリストの曲を、シャッフルとリピートの設定に従って順に選ぶ。
//! 曲そのものは扱わず、プレイリスト内の位置（インデックス）だけを扱う。

/// 再生順。`order` はプレイリスト内の位置を再生する順に並べたもの。
#[derive(Debug, Clone)]
pub struct PlayQueue {
    len: usize,
    order: Vec<usize>,
    /// `order` の中の、今の曲の位置
    pos: usize,
    shuffle: bool,
    repeat: bool,
    rng: fastrand::Rng,
}

impl PlayQueue {
    /// `len` 曲のプレイリストを、`start` 番目の曲から再生する再生順を作る。
    pub fn new(len: usize, start: usize, shuffle: bool, repeat: bool) -> Self {
        Self::with_rng(len, start, shuffle, repeat, fastrand::Rng::new())
    }

    /// 乱数の種を指定して作る（テスト用）。
    pub fn with_rng(len: usize, start: usize, shuffle: bool, repeat: bool, rng: fastrand::Rng) -> Self {
        let mut queue = Self {
            len,
            order: (0..len).collect(),
            pos: start.min(len.saturating_sub(1)),
            shuffle: false,
            repeat,
            rng,
        };
        if shuffle {
            queue.set_shuffle(true);
        }
        queue
    }

    pub fn len(&self) -> usize {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    pub fn shuffle(&self) -> bool {
        self.shuffle
    }

    pub fn repeat(&self) -> bool {
        self.repeat
    }

    /// 今の曲のプレイリスト内の位置。
    pub fn current(&self) -> Option<usize> {
        self.order.get(self.pos).copied()
    }

    /// シャッフルを切り替える。今の曲はそのままにし、オンにしたときは残りの曲の順を混ぜる。
    pub fn set_shuffle(&mut self, shuffle: bool) {
        let current = self.current();
        self.shuffle = shuffle;
        if shuffle {
            self.order = (0..self.len).collect();
            self.rng.shuffle(&mut self.order);
            // 今の曲を先頭に移し、そこから混ぜた順に進む
            if let Some(cur) = current {
                let i = self.order.iter().position(|&x| x == cur).unwrap();
                self.order.swap(0, i);
            }
            self.pos = 0;
        } else {
            self.order = (0..self.len).collect();
            self.pos = current.unwrap_or(0);
        }
    }

    pub fn set_repeat(&mut self, repeat: bool) {
        self.repeat = repeat;
    }

    /// 次の曲に進む。最後の曲の次は、リピートなら最初に戻り（シャッフルなら順を混ぜ直す）、
    /// そうでなければ `None` を返して位置は変えない。
    pub fn advance(&mut self) -> Option<usize> {
        if self.is_empty() {
            return None;
        }
        if self.pos + 1 < self.len {
            self.pos += 1;
        } else if self.repeat {
            if self.shuffle {
                let last = self.current();
                self.rng.shuffle(&mut self.order);
                // 混ぜ直した直後に同じ曲が続かないようにする
                if self.len > 1 && self.order[0] == last.unwrap() {
                    self.order.swap(0, self.len - 1);
                }
            }
            self.pos = 0;
        } else {
            return None;
        }
        self.current()
    }

    /// 前の曲に戻る。最初の曲の前は、リピートなら最後の曲、そうでなければ最初の曲のまま。
    pub fn go_back(&mut self) -> Option<usize> {
        if self.is_empty() {
            return None;
        }
        if self.pos > 0 {
            self.pos -= 1;
        } else if self.repeat {
            self.pos = self.len - 1;
        }
        self.current()
    }

    /// プレイリスト内の `index` 番目の曲に移る。
    pub fn jump_to(&mut self, index: usize) -> Option<usize> {
        let i = self.order.iter().position(|&x| x == index)?;
        self.pos = i;
        self.current()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seeded(len: usize, start: usize, shuffle: bool, repeat: bool) -> PlayQueue {
        PlayQueue::with_rng(len, start, shuffle, repeat, fastrand::Rng::with_seed(42))
    }

    #[test]
    fn plays_in_order_and_stops_at_end_without_repeat() {
        let mut q = seeded(3, 0, false, false);
        assert_eq!(q.current(), Some(0));
        assert_eq!(q.advance(), Some(1));
        assert_eq!(q.advance(), Some(2));
        assert_eq!(q.advance(), None);
        assert_eq!(q.current(), Some(2), "最後で止まっても位置は変えない");
    }

    #[test]
    fn repeat_returns_to_first() {
        let mut q = seeded(3, 2, false, true);
        assert_eq!(q.advance(), Some(0));
        assert_eq!(q.go_back(), Some(2), "最初の曲の前は最後の曲");
    }

    #[test]
    fn prev_at_first_without_repeat_stays() {
        let mut q = seeded(3, 0, false, false);
        assert_eq!(q.go_back(), Some(0));
    }

    #[test]
    fn shuffle_plays_every_track_once_per_round() {
        let mut q = seeded(10, 3, true, false);
        assert_eq!(q.current(), Some(3), "シャッフルしても今の曲から始まる");
        let mut played = vec![q.current().unwrap()];
        while let Some(i) = q.advance() {
            played.push(i);
        }
        let mut sorted = played.clone();
        sorted.sort();
        assert_eq!(sorted, (0..10).collect::<Vec<_>>(), "全曲が一度ずつ出る: {played:?}");
        assert_ne!(played, (0..10).collect::<Vec<_>>(), "順が混ざっている");
    }

    #[test]
    fn shuffle_with_repeat_reshuffles_without_immediate_repeat() {
        let mut q = seeded(5, 0, true, true);
        for _round in 0..20 {
            let mut round = vec![q.current().unwrap()];
            for _ in 1..5 {
                round.push(q.advance().unwrap());
            }
            let last = *round.last().unwrap();
            let first_of_next = q.advance().unwrap();
            assert_ne!(first_of_next, last, "混ぜ直しても同じ曲が続かない");
            let mut sorted = round.clone();
            sorted.sort();
            assert_eq!(sorted, vec![0, 1, 2, 3, 4]);
        }
    }

    #[test]
    fn turning_shuffle_off_keeps_current_track() {
        let mut q = seeded(10, 0, true, false);
        q.advance();
        q.advance();
        let cur = q.current();
        q.set_shuffle(false);
        assert_eq!(q.current(), cur);
        assert_eq!(q.advance(), cur.map(|c| c + 1).filter(|&n| n < 10));
    }

    #[test]
    fn jump_to_moves_to_index() {
        let mut q = seeded(5, 0, true, false);
        assert_eq!(q.jump_to(4), Some(4));
        assert_eq!(q.jump_to(9), None);
    }

    #[test]
    fn empty_queue() {
        let mut q = seeded(0, 0, true, true);
        assert_eq!(q.current(), None);
        assert_eq!(q.advance(), None);
        assert_eq!(q.go_back(), None);
    }
}
