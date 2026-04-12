fn add_rule_redundant_action_insert_demo() {
    MyTx::add_rule("redundant_action_insert_demo", ruleset, || {
        let l = Const::query();
        let r = Const::query();
        let p = Add::query(&l, &r);
        DemoPat::new(l, r, p)
    }, |ctx, pat| {
        let duplicate = ctx.insert_add(pat.l, pat.r);
        ctx.union(pat.p, duplicate);
    });
}
