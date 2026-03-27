fn add_rule_demo() {
    let expr = Add::new(&Const::new(1), &Const::new(2));
    expr.commit();
    MyTx::add_rule(
        "demo",
        ruleset,
        || {
            let l = Const::query();
            let r = Const::query();
            let p = Add::query(&l, &r);
            let eq = x1.handle().eq(&(x.handle() + (&1_i64).as_handle()));
            DemoPat::new(l, r, p).assert(eq)
        },
        |ctx, pat| {
            let op_value = ctx.insert_const(3);
            ctx.union(pat.p, op_value);
        },
    );
}

#[eggplant::dsl]
enum DisplayMath {
    #[eggplant::display("{x} + {f}")]
    #[eggplant::typst("diff ${x}, {f}$")]
    MDiff {
        x: DisplayMath,
        f: DisplayMath,
    },
    #[eggplant::display("integ {f} {x}")]
    #[eggplant::typst("${f}, {x}$")]
    MIntegral {
        f: DisplayMath,
        x: DisplayMath,
    },
    MLeaf {
        n: i64,
    },
}

fn add_rule_display_demo() {
    MyTx::add_rule(
        "display_demo",
        ruleset,
        || {
            let xxx = DisplayMath::query_leaf();
            let f = DisplayMath::query_leaf();
            let diff = MDiff::query(&xxx, &f);
            DisplayPat::new(xxx, f, diff)
        },
        |ctx, pat| {
            let integral = ctx.insert_m_integral(pat.f, pat.x);
            ctx.union(pat.diff, integral);
        },
    );
}

fn step_pat<PR: PatRecSgl>() -> StepPat<PR> {
    let lhs = Const::query();
    let rhs = Const::query();
    let q = Mul::query(&lhs, &rhs);
    StepPat::new(lhs, rhs, q)
}

fn add_rule_assert_block_demo() {
    let expr2 = Add::new(&Const::new(3), &Const::new(3));
    expr2.commit();
    MyTx::add_rule(
        "demo_assert_block",
        ruleset,
        || {
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
        },
        |ctx, pat| {
            let folded = ctx.insert_const(6);
            ctx.union(pat.p, folded);
        },
    );
}

fn not_a_pattern() {
    println!("not a pattern");
}
