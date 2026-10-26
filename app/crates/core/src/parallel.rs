//! 通信を伴う処理（Drive のタグやプレイリストの読み込み）を、決まった数ずつ並行して行う。

use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

/// `items` のそれぞれを、最大 `parallelism` 本のスレッドで並行して `f` に通し、結果を同じ順に返す。
/// `progress` には、1 件終わるたびに（終えた数, 合計）が渡される。
pub fn map_parallel<T, R>(
    items: &[T],
    parallelism: usize,
    f: impl Fn(&T) -> R + Sync,
    progress: impl Fn(usize, usize) + Sync,
) -> Vec<R>
where
    T: Sync,
    R: Send,
{
    let total = items.len();
    let next = AtomicUsize::new(0);
    let done = AtomicUsize::new(0);
    let results: Vec<Mutex<Option<R>>> = items.iter().map(|_| Mutex::new(None)).collect();
    std::thread::scope(|scope| {
        for _ in 0..parallelism.max(1).min(total) {
            scope.spawn(|| {
                loop {
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    let Some(item) = items.get(i) else { break };
                    *results[i].lock().unwrap() = Some(f(item));
                    progress(done.fetch_add(1, Ordering::Relaxed) + 1, total);
                }
            });
        }
    });
    results.into_iter().map(|r| r.into_inner().unwrap().expect("すべての項目を処理し終えている")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_order_and_reports_progress() {
        let items: Vec<u32> = (0..50).collect();
        let calls = AtomicUsize::new(0);
        let out = map_parallel(
            &items,
            8,
            |x| x * 2,
            |done, total| {
                assert!(done <= total && total == 50);
                calls.fetch_add(1, Ordering::Relaxed);
            },
        );
        assert_eq!(out, items.iter().map(|x| x * 2).collect::<Vec<_>>());
        assert_eq!(calls.load(Ordering::Relaxed), 50);
    }

    #[test]
    fn handles_empty_and_zero_parallelism() {
        assert!(map_parallel(&[] as &[u8], 4, |x| *x, |_, _| {}).is_empty());
        assert_eq!(map_parallel(&[1, 2], 0, |x| x + 1, |_, _| {}), vec![2, 3]);
    }
}
