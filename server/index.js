
require("dotenv").config(); // Load environment variables
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const bodyParser = require("body-parser");

const app = express();

// Middleware
app.use(express.json());
app.use(cors());

// MongoDB connection
mongoose
    .connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
    .then(() => console.log("MongoDB connected"))
    .catch((error) => console.error("MongoDB connection error:", error));

// Define the customer and order schema and models
const customerSchema = new mongoose.Schema({
    name: String,
    address: {
        line1: String,
        postal_code: String,
        city: String,
        state: String,
        country: String,
    },
});

const Customer = mongoose.model("Customer", customerSchema);

const orderSchema = new mongoose.Schema({
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer" },
    products: [
        {
            dish: String,
            price: Number,
            qnty: Number,
        },
    ],
    amount: Number,
    status: { type: String, default: "pending" }, // Add status for tracking payment status
    createdAt: { type: Date, default: Date.now },
});

const Order = mongoose.model("Order", orderSchema);

// Stripe checkout session creation
app.post("/api/create-checkout-session", async (req, res) => {
    const { products } = req.body;

    try {
        const lineItems = products.map((product) => ({
            price_data: {
                currency: "inr",
                product_data: {
                    name: product.dish,
                },
                unit_amount: product.price * 100, // Stripe expects the price in cents
            },
            quantity: product.qnty,
        }));

        // Hardcoded customer data
        const customerData = {
            name: "John Doe",
            address: {
                line1: "123 Street Name",
                postal_code: "123456",
                city: "City Name",
                state: "State Name",
                country: "IN",
            },
        };

        // Create customer in the database
        const customer = await Customer.create(customerData);

        // Calculate total amount
        const totalAmount = products.reduce((sum, product) => sum + product.price * product.qnty, 0);

        // Create an order in the database
        const order = await Order.create({
            customerId: customer._id,
            products: products,
            amount: totalAmount,
            status: "pending", // Set initial status to pending
        });

        // Create a customer in Stripe
        const stripeCustomer = await stripe.customers.create({
            name: customerData.name,
            address: customerData.address,
        });

        // Create the checkout session
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ["card"],
            line_items: lineItems,
            mode: "payment",
            customer: stripeCustomer.id, // Attach the customer to the session
            success_url: "http://localhost:3000/success", // Replace with your actual success URL
            cancel_url: "http://localhost:3000/cancel", // Replace with your actual cancel URL
        });

        res.json({ id: session.id });
    } catch (error) {
        console.error("Error creating checkout session:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// Stripe Webhook Endpoint for Payment Status (success or failure)
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

app.post("/webhook", bodyParser.raw({ type: "application/json" }), async (req, res) => {
    const sig = req.headers["stripe-signature"];

    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } catch (err) {
        console.error("Webhook signature verification failed:", err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle the event
    switch (event.type) {
        case "checkout.session.completed":
            const session = event.data.object;

            // Payment successful, update the order status to 'completed'
            await Order.findOneAndUpdate(
                { customerId: session.customer },
                { status: "completed" },
                (err, order) => {
                    if (err) {
                        console.error("Error updating order:", err);
                    } else {
                        console.log("Order completed:", order);
                    }
                }
            );
            break;

        case "payment_intent.payment_failed":
            const paymentIntent = event.data.object;
            const customerId = paymentIntent.customer;

            // Payment failed, update the order status to 'failed'
            await Order.findOneAndUpdate(
                { customerId: customerId },
                { status: "failed" },
                (err, order) => {
                    if (err) {
                        console.error("Error updating order:", err);
                    } else {
                        console.log("Payment failed for order:", order);
                    }
                }
            );
            break;

        default:
            console.log(`Unhandled event type ${event.type}`);
    }

    // Return a 200 response to acknowledge receipt of the event
    res.json({ received: true });
});

// Start the server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Server started on port ${PORT}`);
});

