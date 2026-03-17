fn add_rule_demo() {
    MyTx::add_rule("demo", ruleset, || {
        let l = Const::query();
        let r = Const::query();
        let p = Add::query(&l, &r);
        let eq = x1.handle().eq(&(x.handle() + (&1_i64).as_handle()));
        DemoPat::new(l, r, p).assert(eq)
    }, |ctx, pat| {});
}

fn step_pat<PR: PatRecSgl>() -> StepPat<PR> {
    let lhs = Const::query();
    let rhs = Const::query();
    let q = Mul::query(&lhs, &rhs);
    StepPat::new(lhs, rhs, q)
}

fn not_a_pattern() {
    println!("not a pattern");
}
