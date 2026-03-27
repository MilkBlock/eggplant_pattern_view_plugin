use eggplant::prelude::*;
use eggplant::tx_rx_vt_pr;

tx_rx_vt_pr!(MyTx, MyPatRec);

#[eggplant::func(output = i64, no_merge)]
struct fib {
    x: i64,
}

fn demo(seed_ruleset: Ruleset) {
    // 这段中文注释会触发 UTF-16 vs UTF-8 offset 差异。
    // 预览光标放在 add_rule 上时，scope 仍应命中 add_rule_call。
    MyTx::add_rule(
        "fib_seed",
        seed_ruleset,
        || {
            #[eggplant::pat_vars_catch]
            struct Unit {}
        },
        |ctx, _pat| {
            ctx.set_fib(0, 0);
            ctx.set_fib(1, 1);
        },
    );
}
