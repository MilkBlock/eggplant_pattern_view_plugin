fn add_rule_demo() {
    let expr = Add::new(&Const::new(1), &Const::new(2));
    expr.commit();
    MyTx::add_rule("demo", ruleset, || {
        let l = Const::query();
        let r = Const::query();
        let p = Add::query(&l, &r);
        let eq = x1.handle().eq(&(x.handle() + (&1_i64).as_handle()));
        DemoPat::new(l, r, p).assert(eq)
    }, |ctx, pat| {
        let op_value = ctx.insert_const(3);
        ctx.union(pat.p, op_value);
    });
}

fn add_rule_assert_block_demo() {
    let expr2 = Add::new(&Const::new(3), &Const::new(3));
    expr2.commit();
    MyTx::add_rule("demo_assert_block", ruleset, || {
        let l = Const::query();
        let r = Const::query();
        let p = Add::query(&l, &r);
        let l_r_eq = l.handle().eq(&r.handle());
        {
            #[eggplant::pat_vars_catch]
            struct AddPat {
                l: Const,
                r: Const,
                p: Add,
            }
        }
        .assert(l_r_eq)
    }, |ctx, pat| {
        let folded = ctx.insert_const(6);
        ctx.union(pat.p, folded);
    });
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
